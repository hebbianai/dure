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
Use the [capture workflow](../.agents/skills/capture-product-media/SKILL.md) for
reviewed footage rather than redrawing a stale mockup as a current screenshot.
The [public documentation identity](../docs/architecture/public-documentation-visual-identity.md)
owns the Mintlify reading surface and its native navigation/theme behavior.
