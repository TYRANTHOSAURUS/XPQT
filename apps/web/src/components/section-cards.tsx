import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { TrendingUpIcon, TrendingDownIcon } from "lucide-react"

export interface SectionCardItem {
  description: string
  title: string
  trend: {
    direction: "up" | "down"
    label: string
  }
  footerPrimary: string
  footerSecondary: string
}

export function SectionCards({ items }: { items: SectionCardItem[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
      {items.map((item) => {
        const TrendIcon = item.trend.direction === "down" ? TrendingDownIcon : TrendingUpIcon
        return (
          <Card key={item.description} className="@container/card">
            <CardHeader>
              <CardDescription>{item.description}</CardDescription>
              <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
                {item.title}
              </CardTitle>
              <CardAction>
                <Badge variant="outline">
                  <TrendIcon />
                  {item.trend.label}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardFooter className="flex-col items-start gap-1.5 text-sm">
              <div className="line-clamp-1 flex gap-2 font-medium">
                {item.footerPrimary}{" "}
                <TrendIcon className="size-4" />
              </div>
              <div className="text-muted-foreground">{item.footerSecondary}</div>
            </CardFooter>
          </Card>
        )
      })}
    </div>
  )
}
