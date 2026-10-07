"""Draw the CartPilot icon (a rounded green tile with a white tick) as PNGs. No dependencies."""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "extension" / "icons"


def pixel(x: float, y: float) -> tuple[int, int, int, float]:
    r = 0.22
    dx, dy = max(abs(x - 0.5) - (0.5 - r), 0), max(abs(y - 0.5) - (0.5 - r), 0)
    if dx * dx + dy * dy > r * r:
        return (0, 0, 0, 0.0)

    def near(ax, ay, bx, by):
        t = max(0.0, min(1.0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
        return ((x - ax - t * (bx - ax)) ** 2 + (y - ay - t * (by - ay)) ** 2) ** 0.5

    if min(near(0.27, 0.53, 0.44, 0.69), near(0.44, 0.69, 0.75, 0.33)) < 0.065:
        return (255, 255, 255, 1.0)
    return (int(22 - 8 * y), int(163 - 35 * y), int(74 - 10 * y), 1.0)


def render(size: int, ss: int = 4) -> bytes:
    rows = bytearray()
    for py in range(size):
        rows.append(0)
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    r, g, b, a = pixel((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size)
                    acc[0] += r * a; acc[1] += g * a; acc[2] += b * a; acc[3] += a
            a = acc[3] / (ss * ss)
            rows += bytes([int(acc[i] / acc[3]) if acc[3] else 0 for i in range(3)] + [int(a * 255)])

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(
        b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 48, 128):
        (OUT / f"icon{size}.png").write_bytes(render(size))
        print("wrote", OUT / f"icon{size}.png")
