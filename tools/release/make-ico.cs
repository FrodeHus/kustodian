// Writes assets/icon.ico, the Windows executable icon, from the PNGs make-icons.sh renders into artifacts/icons/:
//   dotnet run tools/release/make-ico.cs
// The icon holds PNG-compressed entries at 16, 32, 48 and 256 px (Windows Vista and later read PNG entries).
// Exit codes: 0 ok, 3 a rendered PNG is missing or isn't the size its name says.

using System.Buffers.Binary;

int[] sizes = [16, 32, 48, 256];

var root = RepositoryRoot();
var input = Path.Combine(root, "artifacts", "icons");
var output = Path.Combine(root, "assets", "icon.ico");

var images = new List<byte[]>();
foreach (var size in sizes)
{
    var path = Path.Combine(input, $"icon-{size}.png");
    if (!File.Exists(path))
    {
        Console.Error.WriteLine($"make-ico: {path} is missing; run tools/release/make-icons.sh first");
        return 3;
    }

    var png = File.ReadAllBytes(path);
    if (PngSize(png) is not var (width, height) || width != size || height != size)
    {
        Console.Error.WriteLine($"make-ico: {path} isn't a {size}x{size} PNG");
        return 3;
    }

    images.Add(png);
}

// ICONDIR (6 bytes), one ICONDIRENTRY (16 bytes) per image, then the images themselves.
const int DirSize = 6;
const int EntrySize = 16;
var ico = new byte[DirSize + (EntrySize * sizes.Length) + images.Sum(i => i.Length)];
var span = ico.AsSpan();
BinaryPrimitives.WriteUInt16LittleEndian(span[2..], 1); // type: icon
BinaryPrimitives.WriteUInt16LittleEndian(span[4..], (ushort)sizes.Length);

var offset = DirSize + (EntrySize * sizes.Length);
for (var i = 0; i < sizes.Length; i++)
{
    var entry = span.Slice(DirSize + (EntrySize * i), EntrySize);
    var dimension = (byte)(sizes[i] >= 256 ? 0 : sizes[i]); // 0 means 256
    entry[0] = dimension; // width
    entry[1] = dimension; // height
    // entry[2] colour count and entry[3] reserved stay 0.
    BinaryPrimitives.WriteUInt16LittleEndian(entry[4..], 1); // colour planes
    BinaryPrimitives.WriteUInt16LittleEndian(entry[6..], 32); // bits per pixel
    BinaryPrimitives.WriteUInt32LittleEndian(entry[8..], (uint)images[i].Length);
    BinaryPrimitives.WriteUInt32LittleEndian(entry[12..], (uint)offset);
    images[i].CopyTo(span[offset..]);
    offset += images[i].Length;
}

File.WriteAllBytes(output, ico);
Console.WriteLine($"make-ico: wrote {output} ({string.Join(", ", sizes.Select(s => $"{s} px"))})");
return 0;

// The PNG's width and height from its IHDR chunk, or null when it isn't a PNG.
static (int Width, int Height)? PngSize(byte[] png)
{
    ReadOnlySpan<byte> signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if (png.Length < 24 || !png.AsSpan(0, 8).SequenceEqual(signature) || !png.AsSpan(12, 4).SequenceEqual("IHDR"u8))
    {
        return null;
    }

    return (BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(16)), BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(20)));
}

// This file's repository: the folder above tools/release/, found from the running file, else from the working directory.
static string RepositoryRoot()
{
    if (AppContext.GetData("EntryPointFilePath") is string entry)
    {
        return Path.GetFullPath(Path.Combine(Path.GetDirectoryName(entry)!, "..", ".."));
    }

    for (var dir = new DirectoryInfo(Environment.CurrentDirectory); dir is not null; dir = dir.Parent)
    {
        if (File.Exists(Path.Combine(dir.FullName, "Kustodian.slnx")))
        {
            return dir.FullName;
        }
    }

    return Environment.CurrentDirectory;
}
