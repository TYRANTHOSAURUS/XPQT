import { BadRequestException } from '@nestjs/common';
import DOMPurify from 'isomorphic-dompurify';

// Explicit allowlist of SVG tags. Anything else is stripped by DOMPurify.
const ALLOWED_TAGS = [
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'rect',
  'defs', 'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask',
  'text', 'tspan', 'title', 'desc', 'use', 'symbol',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite',
  'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap', 'feFlood',
  'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology',
  'feOffset', 'feSpecularLighting', 'feTile', 'feTurbulence', 'feFuncR',
  'feFuncG', 'feFuncB', 'feFuncA', 'feDistantLight', 'fePointLight', 'feSpotLight',
];

// Explicit allowlist of attributes. Every on* handler is absent by construction.
const ALLOWED_ATTR = [
  'id', 'class', 'style',
  'width', 'height', 'viewBox', 'preserveAspectRatio',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'transform', 'transform-origin',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'opacity',
  'offset', 'stop-color', 'stop-opacity',
  'gradientUnits', 'gradientTransform', 'patternUnits', 'patternTransform',
  'clip-path', 'clip-rule', 'mask', 'filter',
  'xmlns', 'xmlns:xlink', 'version', 'xml:space',
  'text-anchor', 'dominant-baseline', 'font-family', 'font-size', 'font-weight', 'font-style',
  // href/xlink:href are kept in the allowlist so the post-pass can filter by value.
  'href', 'xlink:href',
  // Filter-primitive attributes
  'in', 'in2', 'result', 'type', 'values', 'mode', 'operator', 'stdDeviation',
  'dx', 'dy', 'order', 'kernelMatrix', 'divisor', 'bias', 'targetX', 'targetY',
  'edgeMode', 'preserveAlpha', 'surfaceScale', 'diffuseConstant', 'specularConstant',
  'specularExponent', 'scale', 'xChannelSelector', 'yChannelSelector',
  'flood-color', 'flood-opacity', 'baseFrequency', 'numOctaves', 'seed',
  'stitchTiles', 'radius', 'tableValues', 'intercept', 'slope', 'amplitude',
  'exponent',
];

export function sanitizeSvg(input: string): string {
  if (!/<svg[\s>]/i.test(input)) {
    throw new BadRequestException('File does not appear to be an SVG');
  }

  const clean = DOMPurify.sanitize(input, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
  });

  // Post-pass: strip off-origin href / xlink:href values (allowlist keeps the attr
  // name alive; this filters the value). Preserves data: URIs and fragment refs (#id).
  return clean
    .replace(/\s(?:xlink:)?href\s*=\s*"(?!data:|#)[^"]*"/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*'(?!data:|#)[^']*'/gi, '');
}
