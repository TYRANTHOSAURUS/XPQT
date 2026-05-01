/**
 * Space-tree picker — Linear-style popover combobox over the space tree,
 * filtered to selectable kinds.
 *
 * This is a thin wrapper around the existing `SpaceSelect` so we don't
 * fork yet another tree component. The visitor-management admin pages
 * pass a `kindFilter` of `['site', 'building']` (pool anchors must be
 * a site or building per migration 00249's `pool_space_kind` CHECK).
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.5
 */
import { SpaceSelect } from '@/components/space-select';

interface SpaceTreePickerProps {
  value: string;
  onChange: (id: string) => void;
  /** Restrict selectable types. Default: site + building (pool-anchor kinds). */
  kindFilter?: string[];
  placeholder?: string;
  emptyLabel?: string | null;
  id?: string;
  className?: string;
}

export function SpaceTreePicker({
  value,
  onChange,
  kindFilter = ['site', 'building'],
  placeholder = 'Select an anchor space…',
  emptyLabel = null,
  id,
  className,
}: SpaceTreePickerProps) {
  return (
    <SpaceSelect
      id={id}
      value={value}
      onChange={onChange}
      typeFilter={kindFilter}
      placeholder={placeholder}
      emptyLabel={emptyLabel}
      className={className}
    />
  );
}
