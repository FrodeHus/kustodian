using Microsoft.Identity.Client;
using Microsoft.Identity.Client.Extensions.Msal;

namespace Kustodian.Auth;

/// <summary>A token cache that can be attached to an MSAL client and has been proven to persist.</summary>
public interface ICachePersistence
{
    /// <summary>Throws when the OS store is not usable.</summary>
    void Verify();

    void Register(ITokenCache cache);
}

public abstract record TokenCacheStatus
{
    private protected TokenCacheStatus()
    {
    }
}

public sealed record Persistent(ICachePersistence Cache) : TokenCacheStatus;

/// <summary>No usable OS store. Tokens live in memory for this run only; the user signs in again next time.</summary>
public sealed record MemoryOnly(string Reason) : TokenCacheStatus;

/// <summary>Sets up the token cache in the OS store: DPAPI on Windows, Keychain on macOS, libsecret on Linux. When that does not
/// work the answer is <see cref="MemoryOnly"/>, never a plain-text file (spec 6.7).</summary>
public static class TokenCacheFactory
{
    private const string CacheFileName = "msal.cache";
    private const string MacService = "com.kustodian.msal";
    private const string MacAccount = "KustodianMsalCache";
    private const string LinuxSchema = "com.kustodian.tokencache";
    private const string LinuxCollection = "default";
    private const string LinuxLabel = "Kustodian MSAL token cache";

    public static Task<TokenCacheStatus> TryCreateAsync(string cacheDir) => TryCreateAsync(cacheDir, CreateRealAsync);

    public static async Task<TokenCacheStatus> TryCreateAsync(
        string cacheDir, Func<StorageCreationProperties, Task<ICachePersistence>> create)
    {
        try
        {
            var properties = new StorageCreationPropertiesBuilder(CacheFileName, cacheDir)
                .WithMacKeyChain(MacService, MacAccount)
                .WithLinuxKeyring(LinuxSchema, LinuxCollection, LinuxLabel,
                    new KeyValuePair<string, string>("Application", "Kustodian"),
                    new KeyValuePair<string, string>("Version", "1"))
                .Build();

            var cache = await create(properties);
            cache.Verify();
            return new Persistent(cache);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new MemoryOnly($"The OS secure store is not available ({ex.GetType().Name}: {ex.Message}).");
        }
    }

    private static async Task<ICachePersistence> CreateRealAsync(StorageCreationProperties properties) =>
        new HelperPersistence(await MsalCacheHelper.CreateAsync(properties));

    private sealed class HelperPersistence(MsalCacheHelper helper) : ICachePersistence
    {
        public void Verify() => helper.VerifyPersistence();

        public void Register(ITokenCache cache) => helper.RegisterCache(cache);
    }
}
