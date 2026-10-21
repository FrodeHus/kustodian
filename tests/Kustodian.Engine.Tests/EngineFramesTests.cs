using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Engine;

namespace Kustodian.Engine.Tests;

public sealed class EngineFramesTests
{
    private static readonly CancellationToken Ct = CancellationToken.None;

    [Fact]
    public async Task Frames_round_trip_and_reject_oversize()
    {
        var request = new EngineRequest("applications | take 1", new DateTimeOffset(2026, 10, 20, 8, 0, 0, TimeSpan.Zero),
            [new EngineTable("applications", [new EngineColumn("displayName", "string")], [new JsonObject { ["displayName"] = "Payroll" }])],
            10);
        var response = new EngineResponse([new EngineColumn("displayName", "string")],
            [[JsonSerializer.SerializeToElement("Payroll")]], 1, 0, null, null);

        using var stream = new MemoryStream();
        await EngineFrames.WriteAsync(stream, request, Ct);
        await EngineFrames.WriteAsync(stream, response, Ct);
        stream.Position = 0;

        var readRequest = await EngineFrames.ReadAsync<EngineRequest>(stream, 1 << 20, Ct);
        var readResponse = await EngineFrames.ReadAsync<EngineResponse>(stream, 1 << 20, Ct);
        var end = await EngineFrames.ReadAsync<EngineResponse>(stream, 1 << 20, Ct);

        Assert.NotNull(readRequest);
        Assert.Equal(request.Kql, readRequest.Kql);
        Assert.Equal(request.Now, readRequest.Now);
        Assert.Equal(10, readRequest.MaxRows);
        Assert.Equal("Payroll", (string?)readRequest.Tables[0].Rows[0]["displayName"]);
        Assert.NotNull(readResponse);
        Assert.Equal("Payroll", readResponse.Rows![0][0].GetString());
        Assert.Equal(1, readResponse.Total);
        Assert.Null(end);

        stream.Position = 0;
        await Assert.ThrowsAsync<EngineFrameTooLargeException>(() => EngineFrames.ReadAsync<EngineRequest>(stream, 16, Ct));
    }

    [Fact]
    public async Task Frame_is_four_byte_big_endian_length_then_utf8_json_with_web_names()
    {
        using var stream = new MemoryStream();
        await EngineFrames.WriteAsync(stream, new EngineColumn("x", "long"), Ct);

        var bytes = stream.ToArray();
        var length = BinaryPrimitives.ReadInt32BigEndian(bytes);
        Assert.Equal(bytes.Length - 4, length);
        Assert.Equal("""{"name":"x","type":"long"}""", System.Text.Encoding.UTF8.GetString(bytes, 4, length));
    }

    [Theory]
    [InlineData(new byte[] { 0, 0 })]
    [InlineData(new byte[] { 0, 0, 0, 10, (byte)'{' })]
    [InlineData(new byte[] { 0x80, 0, 0, 0 })]
    public async Task Truncated_or_negative_frames_are_malformed(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes);

        await Assert.ThrowsAsync<InvalidDataException>(() => EngineFrames.ReadAsync<EngineRequest>(stream, 1 << 20, Ct));
    }

    [Theory]
    [InlineData("abc")]
    [InlineData("null")]
    public async Task A_frame_that_isnt_a_json_message_is_malformed(string body)
    {
        using var stream = new MemoryStream([0, 0, 0, (byte)body.Length, .. System.Text.Encoding.UTF8.GetBytes(body)]);

        await Assert.ThrowsAsync<InvalidDataException>(() => EngineFrames.ReadAsync<EngineRequest>(stream, 1 << 20, Ct));
    }
}
