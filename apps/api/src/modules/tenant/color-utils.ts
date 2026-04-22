import { BadRequestException } from '@nestjs/common';

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function isValidHex(value: string): boolean {
  return HEX_RE.test(value);
}

export function assertValidHex(value: string, field: string): void {
  if (!isValidHex(value)) {
    throw new BadRequestException(`${field} must be a 6-digit hex color (e.g. #2563eb)`);
  }
}

function srgbToLinear(c: number): number {
  const n = c / 255;
  return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  assertValidHex(hex, 'color');
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastAgainstWhite(hex: string): number {
  const l = relativeLuminance(hex);
  return 1.05 / (l + 0.05);
}

export function assertUsablePrimary(hex: string): void {
  const ratio = contrastAgainstWhite(hex);
  if (ratio < 3) {
    throw new BadRequestException(
      `Primary color contrast against white is ${ratio.toFixed(2)}:1 (must be at least 3:1 for readability)`,
    );
  }
}
