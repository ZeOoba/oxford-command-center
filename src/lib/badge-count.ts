/** Count label shared by tab strips and the rail: caps at "99+". */
export function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}
