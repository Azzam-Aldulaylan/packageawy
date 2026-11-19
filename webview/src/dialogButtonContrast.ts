type Color = { channels: number[]; alpha: number };

/** Parse computed sRGB colors, including the alpha emitted by either host. */
function parseColor(value: string): Color | null {
  const color = value.trim().toLowerCase();
  if (color === 'transparent') return { channels: [0, 0, 0], alpha: 0 };
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.exec(color);
  if (hex !== null) {
    const digits = hex[1]!;
    const expanded = digits.length <= 4 ? [...digits].map(digit => digit + digit).join('') : digits;
    return {
      channels: [0, 2, 4].map(index => parseInt(expanded.slice(index, index + 2), 16) / 255),
      alpha: expanded.length === 8 ? parseInt(expanded.slice(6), 16) / 255 : 1,
    };
  }
  const rgb = /^rgba?\(([^()]+)\)$/.exec(color);
  const srgb = /^color\(srgb\s+([^()]+)\)$/.exec(color);
  const components = (rgb?.[1] ?? srgb?.[1])?.trim().split(/[\s,/]+/);
  if (components === undefined || components.length < 3 || components.length > 4) return null;
  if (components.some(component => !/^[+-]?(?:\d*\.)?\d+%?$/.test(component))) return null;
  const values = components.map((component, index) => {
    const scale = component.endsWith('%') ? 100 : index < 3 && rgb !== null ? 255 : 1;
    return Number.parseFloat(component) / scale;
  });
  if (values.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 1)) return null;
  return { channels: values.slice(0, 3), alpha: values[3] ?? 1 };
}

function composite(front: Color, back: Color): Color {
  const alpha = front.alpha + back.alpha * (1 - front.alpha);
  return {
    alpha,
    channels: front.channels.map((channel, index) => alpha === 0 ? 0
      : (channel * front.alpha + back.channels[index]! * back.alpha * (1 - front.alpha)) / alpha),
  };
}

function luminance(channels: number[]): number {
  const linear = channels.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

/** Surfaces are ordered from the footer outwards, until an opaque backing is found. */
export function filledButtonForeground(background: string, surfaces: string | readonly string[]): '#000000' | '#ffffff' | null {
  const accent = parseColor(background);
  if (accent === null) return null;
  let surface: Color = { channels: [0, 0, 0], alpha: 0 };
  for (const value of typeof surfaces === 'string' ? [surfaces] : surfaces) {
    const backing = parseColor(value);
    if (backing === null) return null;
    surface = composite(surface, backing);
    if (surface.alpha === 1) break;
  }
  if (surface.alpha !== 1) return null;
  const fillLuminance = luminance(composite(accent, surface).channels);
  const surfaceLuminance = luminance(surface.channels);
  // A visible fill boundary needs 3:1 against the dialog. Otherwise use the host's button pair.
  const boundaryContrast = (Math.max(fillLuminance, surfaceLuminance) + 0.05) / (Math.min(fillLuminance, surfaceLuminance) + 0.05);
  if (boundaryContrast < 3) return null;
  // The better of black and white always exceeds 4.58:1 on the composited fill.
  return (fillLuminance + 0.05) / 0.05 >= 1.05 / (fillLuminance + 0.05) ? '#000000' : '#ffffff';
}
