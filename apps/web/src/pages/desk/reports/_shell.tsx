import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ConstructionIcon } from 'lucide-react';

export function ReportShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="@container/main flex flex-1 flex-col">
      <div className="flex flex-col gap-1 px-4 lg:px-6 py-6 border-b">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">{children}</div>
    </div>
  );
}

export function ComingSoon({ title, description }: { title: string; description: string }) {
  return (
    <ReportShell title={title} description={description}>
      <div className="px-4 lg:px-6">
        <Card className="@container/card border-dashed">
          <CardHeader className="items-start gap-2">
            <div className="flex size-10 items-center justify-center rounded-md bg-muted">
              <ConstructionIcon className="size-5 text-muted-foreground" />
            </div>
            <CardTitle>Coming soon</CardTitle>
            <CardDescription>
              This report is under construction. We&apos;re planning to light it up once the backing endpoint is available.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            In the meantime, check the Overview for an all-in-one dashboard of current desk activity.
          </CardContent>
        </Card>
      </div>
    </ReportShell>
  );
}
