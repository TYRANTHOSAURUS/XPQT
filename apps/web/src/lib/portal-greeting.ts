export function timeOfDayGreeting(now: Date = new Date()): 'Good morning' | 'Good afternoon' | 'Good evening' {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
