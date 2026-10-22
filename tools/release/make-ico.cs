// Writes a Windows .ico from square PNG files, each stored as a PNG-compressed entry (Windows Vista and later read these).
// Usage: dotnet run tools/release/make-ico.cs -- <out.ico> <png>...
using System.Buffers.Binary;

if (args.Length < 2)
{
    Console.Error.WriteLine("usage: make-ico.cs <out.ico> <png>...");
    return 2;
}

var images = args[1..].Select(path => (Path: path, Bytes: File.ReadAllBytes(path))).ToList();
const int HeaderSize = 6;
const int EntrySize = 16;

using var output = File.Create(args[0]);
using var writer = new BinaryWriter(output);
writer.Write((ushort)0);
writer.Write((ushort)1);
writer.Write((ushort)images.Count);

var offset = HeaderSize + (EntrySize * images.Count);
foreach (var (path, bytes) in images)
{
    var size = PngSize(path, bytes);
    // A size of 256 is written as 0.
    writer.Write((byte)(size % 256));
    writer.Write((byte)(size % 256));
    writer.Write((byte)0);
    writer.Write((byte)0);
    writer.Write((ushort)1);
    writer.Write((ushort)32);
    writer.Write(bytes.Length);
    writer.Write(offset);
    offset += bytes.Length;
}

foreach (var (_, bytes) in images)
{
    writer.Write(bytes);
}

return 0;

// The width from the PNG's IHDR chunk, which follows the 8-byte signature and the chunk's length and type.
static int PngSize(string path, byte[] bytes)
{
    ReadOnlySpan<byte> signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if (bytes.Length < 24 || !bytes.AsSpan(0, 8).SequenceEqual(signature))
    {
        throw new InvalidDataException($"{path} is not a PNG");
    }

    var width = BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(16));
    var height = BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(20));
    if (width != height || width is < 1 or > 256)
    {
        throw new InvalidDataException($"{path} is {width}x{height}; an icon entry must be square and at most 256 px");
    }

    return width;
}
