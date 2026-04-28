/**
 * User-account status → dot-color class. Centralised so the
 * /admin/persons platform-access cell, /admin/users status column,
 * and both inspector/route headers stay in lockstep.
 */
export function userStatusDotClass(status: string | null | undefined): string {
  switch (status) {
    case 'active':
      return 'bg-emerald-500';
    case 'suspended':
      return 'bg-amber-500';
    case 'inactive':
    default:
      return 'bg-muted-foreground/40';
  }
}
