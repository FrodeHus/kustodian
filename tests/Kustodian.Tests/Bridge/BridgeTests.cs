using System.Text.Json;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Messaging;
using Kustodian.Messaging.Handlers;
using Kustodian.Sources.Hunting;

namespace Kustodian.Tests.Bridge;

public class BridgeTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private readonly List<string> _sent = [];

    [Fact]
    public async Task Unknown_method_returns_error_code_unknown_method()
    {
        var bridge = NewBridge();

        var reply = Parse(await bridge.HandleAsync("""{"id":"1","method":"no.such","params":{}}"""));

        Assert.Equal("1", reply.GetProperty("id").GetString());
        Assert.Equal("unknown_method", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.False(reply.TryGetProperty("result", out _));
    }

    [Fact]
    public async Task Handler_exception_returns_error_code_failed_with_message_and_no_stack()
    {
        var bridge = NewBridge();
        bridge.Register("boom", (_, _) => Throw());

        var raw = await bridge.HandleAsync("""{"id":"7","method":"boom","params":{}}""");
        var reply = Parse(raw);

        var error = reply.GetProperty("error");
        Assert.Equal("7", reply.GetProperty("id").GetString());
        Assert.Equal("failed", error.GetProperty("code").GetString());
        Assert.Equal("The thing broke.", error.GetProperty("message").GetString());
        Assert.Equal(["code", "message"], error.EnumerateObject().Select(p => p.Name));
        Assert.DoesNotContain("InvalidOperationException", raw, StringComparison.Ordinal);
        Assert.DoesNotContain(" at ", raw, StringComparison.Ordinal);
        Assert.DoesNotContain(nameof(Throw), raw, StringComparison.Ordinal);

        static Task<object?> Throw() => throw new InvalidOperationException("The thing broke.");
    }

    [Fact]
    public async Task Run_then_cancel_same_tab_cancels_the_run()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var observed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var bridge = NewBridge(async (_, _, _, _, _, _, ct) =>
        {
            started.SetResult();
            try
            {
                await Task.Delay(Timeout.Infinite, ct);
            }
            finally
            {
                observed.SetResult(ct.IsCancellationRequested);
            }

            throw new InvalidOperationException("unreachable");
        });

        var run = bridge.HandleAsync(Run("r1", "t1", "users"));
        await started.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        var cancel = Parse(await bridge.HandleAsync("""{"id":"c1","method":"query.cancel","params":{"tabId":"t1"}}"""));
        var reply = Parse(await run.WaitAsync(Patience, TestContext.Current.CancellationToken));

        Assert.Equal(JsonValueKind.Object, cancel.GetProperty("result").ValueKind);
        Assert.True(await observed.Task.WaitAsync(Patience, TestContext.Current.CancellationToken));
        Assert.Equal("r1", reply.GetProperty("id").GetString());
        Assert.Equal("cancelled", reply.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Second_run_on_same_tab_cancels_the_first()
    {
        var firstStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var bridge = NewBridge(async (_, kql, _, _, _, _, ct) =>
        {
            if (kql == "slow")
            {
                firstStarted.SetResult();
                await Task.Delay(Timeout.Infinite, ct);
            }

            return Ok();
        });

        var first = bridge.HandleAsync(Run("r1", "t1", "slow"));
        await firstStarted.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        var second = Parse(await bridge.HandleAsync(Run("r2", "t1", "fast")).WaitAsync(Patience, TestContext.Current.CancellationToken));
        var firstReply = Parse(await first.WaitAsync(Patience, TestContext.Current.CancellationToken));

        Assert.Equal("cancelled", firstReply.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("r2", second.GetProperty("id").GetString());
        Assert.Equal("ok", second.GetProperty("result").GetProperty("outcome").GetString());
    }

    [Fact]
    public async Task Runs_on_other_tabs_are_not_cancelled()
    {
        var bridge = NewBridge((_, _, _, _, _, _, _) => Task.FromResult(Ok()));

        var a = Parse(await bridge.HandleAsync(Run("r1", "t1", "users")));
        var b = Parse(await bridge.HandleAsync(Run("r2", "t2", "users")));

        Assert.Equal("ok", a.GetProperty("result").GetProperty("outcome").GetString());
        Assert.Equal("ok", b.GetProperty("result").GetProperty("outcome").GetString());
    }

    [Fact]
    public async Task Progress_events_carry_tab_id_and_run_id()
    {
        const string RunId = "6f1c0a52-8d1e-4f57-9a43-0b8f6a1f2c11";
        var bridge = NewBridge((_, _, _, _, _, progress, _) =>
        {
            progress?.Report(new RunEvent("planning", "Planning the query", RunId));
            progress?.Report(new RunEvent("fetching", "users", RunId));
            return Task.FromResult(Ok());
        });

        await bridge.HandleAsync(Run("r1", "tab-42", "users"));

        var events = _sent.Select(s => Parse(s)).Where(e => e.GetProperty("event").GetString() == "query.progress").ToList();
        Assert.Equal(2, events.Count);
        var data = events[0].GetProperty("data");
        Assert.Equal("tab-42", data.GetProperty("tabId").GetString());
        Assert.Equal("planning", data.GetProperty("stage").GetString());
        Assert.Equal("Planning the query", data.GetProperty("detail").GetString());
        Assert.Equal(RunId, data.GetProperty("runId").GetString());
        Assert.Equal(["tabId", "runId", "stage", "detail"], data.EnumerateObject().Select(p => p.Name));
        Assert.Equal("tab-42", events[1].GetProperty("data").GetProperty("tabId").GetString());
        Assert.Equal("fetching", events[1].GetProperty("data").GetProperty("stage").GetString());
    }

    [Fact]
    public async Task Run_without_account_returns_sign_in_needed_without_calling_graph()
    {
        var called = false;
        var bridge = NewBridge((_, _, _, _, _, _, _) =>
        {
            called = true;
            return Task.FromResult(Ok());
        }, account: null);

        var reply = Parse(await bridge.HandleAsync(Run("r1", "t1", "users")));

        Assert.False(called);
        Assert.Equal("signInNeeded", reply.GetProperty("result").GetProperty("outcome").GetString());
        Assert.Equal(GraphRunner.SignInMessage, reply.GetProperty("result").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Run_passes_active_account_kql_and_refresh()
    {
        (string Account, string Kql, bool Refresh)? seen = null;
        var bridge = NewBridge((account, kql, _, refresh, _, _, _) =>
        {
            seen = (account, kql, refresh);
            return Task.FromResult(Ok());
        });

        await bridge.HandleAsync("""{"id":"1","method":"query.run","params":{"tabId":"t","source":"graph","kql":"users | take 1","refresh":true}}""");

        Assert.Equal(("acct-1", "users | take 1", true), seen);
    }

    [Fact]
    public async Task Run_passes_parameters_with_missing_fields_defaulted()
    {
        IReadOnlyList<ParameterValue>? seen = null;
        var bridge = NewBridge((_, _, parameters, _, _, _, _) =>
        {
            seen = parameters;
            return Task.FromResult(Ok());
        });

        await bridge.HandleAsync("""
            {"id":"1","method":"query.run","params":{"tabId":"t","source":"graph","kql":"users","refresh":false,
             "parameters":[{"name":"days","type":"number","value":"30","required":true},{"name":"q"},{"name":"r","type":null}]}}
            """);

        Assert.Equal([new ParameterValue("days", "number", "30", true), new ParameterValue("q", "text", "", false),
            new ParameterValue("r", "text", "", false)], seen);
    }

    [Fact]
    public async Task Run_without_parameters_passes_none()
    {
        IReadOnlyList<ParameterValue>? seen = null;
        var bridge = NewBridge((_, _, parameters, _, _, _, _) =>
        {
            seen = parameters;
            return Task.FromResult(Ok());
        });

        await bridge.HandleAsync("""{"id":"1","method":"query.run","params":{"tabId":"t","source":"graph","kql":"users"}}""");

        Assert.NotNull(seen);
        Assert.Empty(seen);
    }

    [Fact]
    public async Task Run_with_malformed_parameters_returns_bad_request()
    {
        var bridge = NewBridge((_, _, _, _, _, _, _) => Task.FromResult(Ok()));

        var reply = Parse(await bridge.HandleAsync(
            """{"id":"1","method":"query.run","params":{"tabId":"t","source":"graph","kql":"x","parameters":{"n":"1"}}}"""));

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("""[null]""")]
    [InlineData("""[{"name":"n"},null]""")]
    [InlineData("""["n"]""")]
    [InlineData("""[{"name":"n","value":5}]""")]
    public async Task Run_with_a_parameter_that_is_not_an_object_returns_bad_request(string parameters)
    {
        var called = false;
        var bridge = NewBridge((_, _, _, _, _, _, _) =>
        {
            called = true;
            return Task.FromResult(Ok());
        });

        var reply = Parse(await bridge.HandleAsync(
            """{"id":"1","method":"query.run","params":{"tabId":"t","source":"graph","kql":"x","parameters":""" + parameters + "}}"));

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.False(called);
    }

    [Fact]
    public async Task Run_with_unknown_source_returns_bad_request()
    {
        var bridge = NewBridge((_, _, _, _, _, _, _) => Task.FromResult(Ok()));

        var reply = Parse(await bridge.HandleAsync("""{"id":"1","method":"query.run","params":{"tabId":"t","source":"hunting","kql":"x"}}"""));

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Schema_get_graph_returns_tables_with_permissions()
    {
        var bridge = NewBridge();
        SchemaHandlerTests.Handler(null).Register(bridge);

        var reply = Parse(await bridge.HandleAsync("""{"id":"s","method":"schema.get","params":{"source":"graph"}}"""));

        var view = reply.GetProperty("result");
        Assert.Equal(GraphSchemaCatalog.Beta.Source, view.GetProperty("source").GetString());
        Assert.Equal("builtIn", view.GetProperty("origin").GetString());
        Assert.Equal(JsonValueKind.Null, view.GetProperty("fallbackReason").ValueKind);
        Assert.Empty(view.GetProperty("functions").EnumerateArray());
        Assert.Equal(JsonValueKind.String, view.GetProperty("generatedAt").ValueKind);
        Assert.Equal(JsonValueKind.Object, view.GetProperty("complexTypes").ValueKind);
        var tables = view.GetProperty("tables").EnumerateArray().ToList();
        Assert.Equal(GraphSchemaCatalog.Beta.Tables.Count, tables.Count);
        var users = tables.Single(t => t.GetProperty("name").GetString() == "users");
        Assert.Equal("users", users.GetProperty("path").GetString());
        // The raw tab completes Graph paths, not KQL table names.
        var signIns = tables.Single(t => t.GetProperty("name").GetString() == "auditLogs_signIns");
        Assert.Equal("auditLogs/signIns", signIns.GetProperty("path").GetString());
        // Every Graph table carries its data area, worked out from the path; the panel groups by it.
        Assert.Equal("Users, groups and directory", users.GetProperty("area").GetString());
        Assert.Equal("Sign-in and audit logs", signIns.GetProperty("area").GetString());
        Assert.All(tables, t => Assert.Contains(t.GetProperty("area").GetString(), GraphAreas.Names));
        Assert.NotEmpty(users.GetProperty("permissions").EnumerateArray());
        Assert.False(string.IsNullOrEmpty(users.GetProperty("docsUrl").GetString()));
        Assert.Equal(JsonValueKind.String, users.GetProperty("description").ValueKind);
        var columns = users.GetProperty("columns").EnumerateArray().ToList();
        var displayName = columns.Single(c => c.GetProperty("name").GetString() == "displayName");
        Assert.Equal(
            ["name", "type", "description", "filterable", "listable", "complexType", "collection"],
            displayName.EnumerateObject().Select(p => p.Name));
        Assert.Equal("string", displayName.GetProperty("type").GetString());
        Assert.True(displayName.GetProperty("filterable").GetBoolean());
        Assert.False(columns.Single(c => c.GetProperty("name").GetString() == "id").GetProperty("filterable").GetBoolean());
    }

    [Fact]
    public async Task Schema_listed_by_default_gives_the_active_accounts_default_columns_by_table_name()
    {
        var bridge = NewBridge();
        var probes = new MemoryGraphProbeCache(TimeProvider.System);
        await probes.SetDefaultsAsync("account-1", "auditLogs/signIns", ["id", "createdDateTime"], CancellationToken.None);
        await probes.SetDefaultsAsync("account-2", "users", ["id", "displayName"], CancellationToken.None);
        new SchemaHandler(GraphSchemaCatalog.Beta, new HuntingSchemaSource(new HttpClient(), TimeProvider.System), () => Task.FromResult<string?>("account-1"), probes).Register(bridge);

        var reply = Parse(await bridge.HandleAsync("""{"id":"s","method":"schema.listedByDefault","params":{"source":"graph"}}"""));

        var tables = reply.GetProperty("result").GetProperty("tables");
        Assert.Equal(["auditLogs_signIns"], tables.EnumerateObject().Select(p => p.Name));
        Assert.Equal(["id", "createdDateTime"], tables.GetProperty("auditLogs_signIns").EnumerateArray().Select(c => c.GetString()));
    }

    [Fact]
    public async Task Schema_listed_by_default_without_an_account_is_empty()
    {
        var bridge = NewBridge();
        var probes = new MemoryGraphProbeCache(TimeProvider.System);
        await probes.SetDefaultsAsync("account-1", "users", ["id"], CancellationToken.None);
        new SchemaHandler(GraphSchemaCatalog.Beta, new HuntingSchemaSource(new HttpClient(), TimeProvider.System), () => Task.FromResult<string?>(null), probes).Register(bridge);

        var reply = Parse(await bridge.HandleAsync("""{"id":"s","method":"schema.listedByDefault","params":{"source":"graph"}}"""));

        Assert.Empty(reply.GetProperty("result").GetProperty("tables").EnumerateObject());
    }

    [Fact]
    public async Task Schema_get_unknown_source_returns_bad_request()
    {
        var bridge = NewBridge();
        SchemaHandlerTests.Handler(null).Register(bridge);

        var reply = Parse(await bridge.HandleAsync("""{"id":"s","method":"schema.get","params":{"source":"sentinel"}}"""));

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Query_complete_returns_fields_of_the_complex_value()
    {
        var bridge = NewBridge((_, _, _, _, _, _, _) => Task.FromResult(Ok()));
        var kql = "users | where passwordProfile.";

        var reply = Parse(await bridge.HandleAsync(JsonSerializer.Serialize(new
        {
            id = "q",
            method = "query.complete",
            @params = new { source = "graph", kql, position = kql.Length },
        })));

        var labels = reply.GetProperty("result").EnumerateArray().Select(i => i.GetProperty("label").GetString()).ToList();
        Assert.Contains("forceChangePasswordNextSignIn", labels);
    }

    [Fact]
    public async Task Explain_needs_no_account()
    {
        var bridge = NewBridge(
            (_, _, _, _, _, _, _) => throw new InvalidOperationException("Explain must not run the query."),
            () => throw new InvalidOperationException("Explain must not look up the account."));

        var reply = Parse(await bridge.HandleAsync(JsonSerializer.Serialize(new
        {
            id = "e",
            method = "query.explain",
            @params = new
            {
                source = "graph",
                kql = "applications | where displayName == {name} | project displayName",
                parameters = new[] { new { name = "name", type = "text", value = "Payroll" } },
            },
        })));

        var view = reply.GetProperty("result");
        Assert.Equal(JsonValueKind.Null, view.GetProperty("error").ValueKind);
        Assert.Equal(JsonValueKind.Null, view.GetProperty("refusal").ValueKind);
        var table = Assert.Single(view.GetProperty("tables").EnumerateArray().ToList());
        Assert.Equal(
            ["table", "url", "select", "filter", "top", "pushed", "local", "perObject", "permissions", "docsUrl", "orderBy", "count", "headers", "relationships", "filteredLocally",
                "licenseLeftOut", "missingLicense", "missingLicenseSource"],
            table.EnumerateObject().Select(p => p.Name));
        Assert.Equal("applications", table.GetProperty("table").GetString());
        Assert.Equal("displayName eq 'Payroll'", table.GetProperty("filter").GetString());
        Assert.StartsWith("applications?$select=", table.GetProperty("url").GetString(), StringComparison.Ordinal);
        Assert.Equal(GraphLimits.Default.ObjectsPerTable, view.GetProperty("limits").GetProperty("objectsPerTable").GetInt32());
    }

    [Fact]
    public async Task Explain_returns_the_error_with_its_position()
    {
        var bridge = NewBridge((_, _, _, _, _, _, _) => Task.FromResult(Ok()));

        var reply = Parse(await bridge.HandleAsync(
            """{"id":"e","method":"query.explain","params":{"source":"graph","kql":"users\n| where nope == 1"}}"""));

        var error = reply.GetProperty("result").GetProperty("error");
        Assert.Equal(2, error.GetProperty("line").GetInt32());
        Assert.Equal(9, error.GetProperty("column").GetInt32());
    }

    [Theory]
    [InlineData("""{"source":"hunting","kql":"x"}""")]
    [InlineData("""{"source":"graph"}""")]
    [InlineData("""{"source":"graph","kql":"x","parameters":[null]}""")]
    public async Task Explain_with_a_bad_request_returns_bad_request(string parameters)
    {
        var bridge = NewBridge((_, _, _, _, _, _, _) => Task.FromResult(Ok()));

        var reply = Parse(await bridge.HandleAsync("""{"id":"e","method":"query.explain","params":""" + parameters + "}"));

        Assert.Equal("bad_request", reply.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public void Emit_sends_event_envelope()
    {
        var bridge = NewBridge();

        bridge.Emit("account.deviceCode", new { message = "Go to https://microsoft.com/devicelogin" });

        var evt = Parse(Assert.Single(_sent));
        Assert.Equal("account.deviceCode", evt.GetProperty("event").GetString());
        Assert.Equal("Go to https://microsoft.com/devicelogin", evt.GetProperty("data").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Message_without_id_gets_no_reply()
    {
        var bridge = NewBridge();

        Assert.Null(await bridge.HandleAsync("""{"method":"app.info"}"""));
        Assert.Null(await bridge.HandleAsync("not json"));
    }

    [Fact]
    public async Task App_info_returns_version_and_platform()
    {
        var bridge = NewBridge();
        new AppHandler(new MemoryGraphObjectCache(TimeProvider.System), NoGraphProbeCache.Instance).Register(bridge);

        var result = Parse(await bridge.HandleAsync("""{"id":"a","method":"app.info","params":{}}""")).GetProperty("result");

        Assert.False(string.IsNullOrEmpty(result.GetProperty("version").GetString()));
        Assert.Contains(result.GetProperty("platform").GetString(), new[] { "windows", "macos", "linux" });
    }

    [Fact]
    public async Task Cache_clear_empties_object_cache_and_probe_findings()
    {
        var bridge = NewBridge();
        var objects = new MemoryGraphObjectCache(TimeProvider.System);
        var probes = new MemoryGraphProbeCache(TimeProvider.System);
        new AppHandler(objects, probes).Register(bridge);
        await probes.SetAsync("account-1", "auditLogs/signIns", ["mfaDetail"], [], CancellationToken.None);
        await objects.SetAsync("account-1", "applications", ["a"], "1", "{}", CancellationToken.None);
        await objects.SetAsync("account-2", "groups", ["b"], "2", "{}", CancellationToken.None);

        var reply = Parse(await bridge.HandleAsync("""{"id":"c","method":"cache.clear","params":{}}"""));

        Assert.Equal(JsonValueKind.Object, reply.GetProperty("result").ValueKind);
        Assert.Empty(reply.GetProperty("result").EnumerateObject());
        Assert.Null(await objects.GetAsync("account-1", "applications", ["a"], "1", CancellationToken.None));
        Assert.Null(await objects.GetAsync("account-2", "groups", ["b"], "2", CancellationToken.None));
        Assert.Null(await probes.GetAsync("account-1", "auditLogs/signIns", CancellationToken.None));
    }

    private Messaging.Bridge NewBridge() => new(message =>
    {
        lock (_sent)
        {
            _sent.Add(message);
        }
    });

    [Fact]
    public async Task Run_result_duration_goes_out_as_duration_ms()
    {
        var bridge = NewBridge((_, _, _, _, _, _, _) =>
            Task.FromResult(Ok() with { Duration = TimeSpan.FromMilliseconds(1234.4) }));

        var result = Parse(await bridge.HandleAsync(Run("r1", "t1", "users"))).GetProperty("result");

        Assert.Equal(JsonValueKind.Number, result.GetProperty("durationMs").ValueKind);
        Assert.Equal(1234, result.GetProperty("durationMs").GetInt64());
        Assert.False(result.TryGetProperty("duration", out _));
        Assert.Equal(
            ["outcome", "message", "error", "columns", "rows", "total", "tables", "durationMs", "droppedValues", "runId", "diagnostics",
                "permissions"],
            result.EnumerateObject().Select(p => p.Name));
    }

    [Fact]
    public async Task Run_result_wire_has_permissions()
    {
        var bridge = NewBridge((_, _, _, _, _, _, _) => Task.FromResult(Ok() with { Permissions = ["Reports.Read.All"] }));

        var result = Parse(await bridge.HandleAsync(Run("r1", "t1", "users"))).GetProperty("result");

        Assert.Equal(["Reports.Read.All"], result.GetProperty("permissions").EnumerateArray().Select(p => p.GetString()));
    }

    [Fact]
    public async Task Run_result_wire_has_run_id_and_diagnostics()
    {
        const string RunId = "0b9f4c1e-2a7d-4e36-8f15-7c2d9e4a6b80";
        var bridge = NewBridge((_, _, _, _, _, _, _) => Task.FromResult(Ok() with
        {
            RunId = RunId,
            Diagnostics =
            [
                new DiagnosticEntry(3, "request", "GET applications?$select=id&$top=999", 200, 120, 2048),
                new DiagnosticEntry(130, "engine", "worker 4242 started", null, null, null),
            ],
        }));

        var result = Parse(await bridge.HandleAsync(Run("r1", "t1", "users"))).GetProperty("result");

        Assert.Equal(RunId, result.GetProperty("runId").GetString());
        var entries = result.GetProperty("diagnostics").EnumerateArray().ToList();
        Assert.Equal(2, entries.Count);
        Assert.Equal(["atMs", "kind", "detail", "status", "durationMs", "bytes"], entries[0].EnumerateObject().Select(p => p.Name));
        Assert.Equal(3, entries[0].GetProperty("atMs").GetInt64());
        Assert.Equal("request", entries[0].GetProperty("kind").GetString());
        Assert.Equal("GET applications?$select=id&$top=999", entries[0].GetProperty("detail").GetString());
        Assert.Equal(200, entries[0].GetProperty("status").GetInt32());
        Assert.Equal(120, entries[0].GetProperty("durationMs").GetInt64());
        Assert.Equal(2048, entries[0].GetProperty("bytes").GetInt64());
        Assert.Equal(JsonValueKind.Null, entries[1].GetProperty("status").ValueKind);
        Assert.Equal("engine", entries[1].GetProperty("kind").GetString());
    }

    [Fact]
    public async Task Run_passes_the_web_s_run_id_to_the_run()
    {
        const string RunId = "3d8e2f6a-5b1c-4c7e-9a2d-1f4b6c8e0a12";
        string? seen = "unset";
        string? missing = "unset";
        var bridge = NewBridge((_, _, _, _, runId, _, _) =>
        {
            if (seen == "unset")
            {
                seen = runId;
            }
            else
            {
                missing = runId;
            }

            return Task.FromResult(Ok());
        });

        await bridge.HandleAsync(JsonSerializer.Serialize(new
        {
            id = "r1", method = "query.run", @params = new { tabId = "t1", source = "graph", kql = "users", refresh = false, runId = RunId },
        }));
        await bridge.HandleAsync(Run("r2", "t1", "users"));

        Assert.Equal(RunId, seen);
        Assert.Null(missing);
    }

    [Fact]
    public async Task A_run_without_an_account_answers_with_the_web_s_run_id_or_a_new_one()
    {
        const string RunId = "3d8e2f6a-5b1c-4c7e-9a2d-1f4b6c8e0a12";
        var bridge = NewBridge((_, _, _, _, _, _, _) => Task.FromResult(Ok()), account: null);

        string RunIdOf(string? reply) => Parse(reply).GetProperty("result").GetProperty("runId").GetString()!;
        var valid = RunIdOf(await bridge.HandleAsync(RunWithId("r1", RunId)));
        var invalid = RunIdOf(await bridge.HandleAsync(RunWithId("r2", "not-a-guid")));

        Assert.Equal(RunId, valid);
        Assert.NotEqual("not-a-guid", invalid);
        Assert.True(Guid.TryParseExact(invalid, "D", out _));

        static string RunWithId(string id, string runId) => JsonSerializer.Serialize(new
        {
            id, method = "query.run", @params = new { tabId = "t1", source = "graph", kql = "users", refresh = false, runId },
        });
    }

    [Fact]
    public async Task A_run_without_an_account_still_has_a_run_id()
    {
        var bridge = NewBridge((_, _, _, _, _, _, _) => Task.FromResult(Ok()), account: null);

        var result = Parse(await bridge.HandleAsync(Run("r1", "t1", "users"))).GetProperty("result");

        Assert.Equal("signInNeeded", result.GetProperty("outcome").GetString());
        Assert.True(Guid.TryParse(result.GetProperty("runId").GetString(), out _));
        Assert.Empty(result.GetProperty("diagnostics").EnumerateArray());
    }

    [Fact]
    public async Task Back_to_back_runs_on_one_tab_leave_the_newer_alive()
    {
        // The older run's account lookup finishes last: the newer run must still be the one left running.
        var lookups = new Queue<TaskCompletionSource<string?>>([NewGate(), NewGate()]);
        var gates = lookups.ToArray();
        var bridge = NewBridge((_, kql, _, _, _, _, ct) =>
        {
            ct.ThrowIfCancellationRequested();
            return Task.FromResult(Ok() with { Message = kql });
        }, () => lookups.Dequeue().Task);

        var first = bridge.HandleAsync(Run("r1", "t1", "older"));
        var second = bridge.HandleAsync(Run("r2", "t1", "newer"));
        gates[1].SetResult("acct-1");
        var secondReply = Parse(await second.WaitAsync(Patience, TestContext.Current.CancellationToken));
        gates[0].SetResult("acct-1");
        var firstReply = Parse(await first.WaitAsync(Patience, TestContext.Current.CancellationToken));

        Assert.Equal("ok", secondReply.GetProperty("result").GetProperty("outcome").GetString());
        Assert.Equal("newer", secondReply.GetProperty("result").GetProperty("message").GetString());
        Assert.Equal("cancelled", firstReply.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Cancel_right_after_run_cancels_it()
    {
        var lookup = NewGate();
        var called = false;
        var bridge = NewBridge((_, _, _, _, _, _, _) =>
        {
            called = true;
            return Task.FromResult(Ok());
        }, () => lookup.Task);

        var run = bridge.HandleAsync(Run("r1", "t1", "users"));
        await bridge.HandleAsync("""{"id":"c1","method":"query.cancel","params":{"tabId":"t1"}}""");
        lookup.SetResult("acct-1");
        var reply = Parse(await run.WaitAsync(Patience, TestContext.Current.CancellationToken));

        Assert.Equal("cancelled", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.False(called);
    }

    [Fact]
    public async Task Bridge_close_cancels_an_in_flight_run()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var bridge = NewBridge(async (_, _, _, _, _, _, ct) =>
        {
            started.SetResult();
            await Task.Delay(Timeout.Infinite, ct);
            return Ok();
        });

        var run = bridge.HandleAsync(Run("r1", "t1", "users"));
        await started.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        bridge.Close();
        var reply = Parse(await run.WaitAsync(Patience, TestContext.Current.CancellationToken));

        Assert.Equal("cancelled", reply.GetProperty("error").GetProperty("code").GetString());
    }

    private static TaskCompletionSource<string?> NewGate() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    private Messaging.Bridge NewBridge(FakeRun run, string? account = "acct-1") =>
        NewBridge(run, () => Task.FromResult(account));

    private Messaging.Bridge NewBridge(FakeRun run, Func<Task<string?>> accountLookup)
    {
        var bridge = NewBridge();
        new QueryHandler(GraphSchemaCatalog.Beta, accountLookup, FakeSource.Graph(run)).Register(bridge);
        return bridge;
    }

    private static string Run(string id, string tabId, string kql) =>
        JsonSerializer.Serialize(new { id, method = "query.run", @params = new { tabId, source = "graph", kql, refresh = false } });

    private static RunResult Ok() => new(RunOutcome.Ok, null, null, [], [], 0, [], TimeSpan.Zero);

    private static JsonElement Parse(string? json)
    {
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }
}
