import { TableCell, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';

interface TableLoadingProps {
  cols: number;
  rows?: number;
}

/** Renders skeleton rows inside a <TableBody> while data is loading. */
export function TableLoading({ cols, rows = 3 }: TableLoadingProps) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <TableRow key={i}>
          {Array.from({ length: cols }).map((_, j) => (
            <TableCell key={j}>
              <Skeleton className="h-4 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

interface TableEmptyProps {
  cols: number;
  message?: string;
}

/** Renders a centered empty-state row spanning all columns. */
export function TableEmpty({ cols, message = 'No results.' }: TableEmptyProps) {
  return (
    <TableRow>
      <TableCell colSpan={cols} className="text-center py-8 text-muted-foreground">
        {message}
      </TableCell>
    </TableRow>
  );
}
