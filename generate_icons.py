#!/usr/bin/env python3
"""Generate PNG icons for the Meal Logger PWA"""

import os
import struct
import zlib

def create_png(width, height, color=(76, 175, 80)):
    """Create a simple solid color PNG with rounded corners effect"""

    def make_pixel(x, y, w, h, r, g, b):
        # Create rounded corners effect
        corner_radius = min(w, h) // 5

        # Check if in corner region
        corners = [
            (corner_radius, corner_radius),  # top-left
            (w - corner_radius - 1, corner_radius),  # top-right
            (corner_radius, h - corner_radius - 1),  # bottom-left
            (w - corner_radius - 1, h - corner_radius - 1),  # bottom-right
        ]

        for cx, cy in corners:
            dx = abs(x - cx) if (x < corner_radius or x >= w - corner_radius) else 0
            dy = abs(y - cy) if (y < corner_radius or y >= h - corner_radius) else 0

            if (x < corner_radius and y < corner_radius) or \
               (x >= w - corner_radius and y < corner_radius) or \
               (x < corner_radius and y >= h - corner_radius) or \
               (x >= w - corner_radius and y >= h - corner_radius):
                dist = (dx * dx + dy * dy) ** 0.5
                if dist > corner_radius:
                    return (0, 0, 0, 0)  # transparent

        # Draw a simple plate/fork icon in center
        center_x, center_y = w // 2, h // 2
        icon_size = min(w, h) // 3

        # Check if in icon area (simple circle for plate)
        dist_from_center = ((x - center_x) ** 2 + (y - center_y) ** 2) ** 0.5

        if dist_from_center < icon_size:
            # Inner circle (plate)
            if dist_from_center < icon_size * 0.8 and dist_from_center > icon_size * 0.6:
                return (255, 255, 255, 255)
            if dist_from_center < icon_size * 0.4:
                return (255, 255, 255, 200)

        return (r, g, b, 255)

    # Create raw pixel data
    raw_data = []
    for y in range(height):
        row = [0]  # Filter byte (none)
        for x in range(width):
            pixel = make_pixel(x, y, width, height, *color)
            row.extend(pixel)
        raw_data.append(bytes(row))

    raw_data = b''.join(raw_data)

    # Compress data
    compressed = zlib.compress(raw_data, 9)

    # Build PNG file
    def png_chunk(chunk_type, data):
        chunk = chunk_type + data
        crc = zlib.crc32(chunk) & 0xffffffff
        return struct.pack('>I', len(data)) + chunk + struct.pack('>I', crc)

    # PNG signature
    png = b'\x89PNG\r\n\x1a\n'

    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    png += png_chunk(b'IHDR', ihdr_data)

    # IDAT chunk
    png += png_chunk(b'IDAT', compressed)

    # IEND chunk
    png += png_chunk(b'IEND', b'')

    return png

def main():
    sizes = [72, 96, 128, 144, 152, 192, 384, 512]
    icons_dir = 'icons'

    os.makedirs(icons_dir, exist_ok=True)

    for size in sizes:
        png_data = create_png(size, size)
        filename = os.path.join(icons_dir, f'icon-{size}.png')
        with open(filename, 'wb') as f:
            f.write(png_data)
        print(f'Created {filename}')

    print('All icons generated!')

if __name__ == '__main__':
    main()
