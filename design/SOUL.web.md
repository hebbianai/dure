# Website design intent

Apply [SOUL](SOUL.md) to the medium: quiet typography, neutral surfaces, restrained
hierarchy, and clear reading order. A website has different type and spacing
needs from a dense IDE. Use its current stylesheet and reviewed brand assets;
do not copy desktop numerical values into a second palette.

Web glass may use CSS backdrop filtering because it has no native window material.
Keep permanent glass to one layer, with temporary menus treated separately;
reading surfaces remain opaque. Avoid decorative scroll/parallax/counter motion,
hover that moves layout, and multiple competing primary actions. Labels must
remain visible rather than being replaced by placeholders.

Product imagery must depict the actual product, using its fonts and geometry.
Follow the [public media workflow](../tools/media-capture/README.md) to capture,
review and sanitize footage. Do not present a redrawn mockup as a current
screenshot. The [documentation maintenance guide](../docs/public/README.md#keep-media-and-brand-assets-reviewable)
describes product figures and the Mintlify reading surface. Its
[configuration](../docs/public/docs.json) and [stylesheet](../docs/public/style.css)
own the published navigation, theme and typography.
