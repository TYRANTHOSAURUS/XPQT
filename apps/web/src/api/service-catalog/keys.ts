export const serviceCatalogKeys = {
  all: ['service-catalog'] as const,
  vendors: () => [...serviceCatalogKeys.all, 'vendors'] as const,
  vendor: (id: string) => [...serviceCatalogKeys.vendors(), id] as const,
  menus: () => [...serviceCatalogKeys.all, 'menus'] as const,
  menu: (id: string) => [...serviceCatalogKeys.menus(), id] as const,
  items: () => [...serviceCatalogKeys.all, 'items'] as const,
  item: (id: string) => [...serviceCatalogKeys.items(), id] as const,
  /**
   * "What can I order here, right now?" — fired by the booking-confirm dialog
   * when each service section opens. Scoped per (location, date) tuple.
   */
  resolved: (delivery_space_id: string, on_date: string) =>
    [...serviceCatalogKeys.all, 'resolved', delivery_space_id, on_date] as const,
} as const;
