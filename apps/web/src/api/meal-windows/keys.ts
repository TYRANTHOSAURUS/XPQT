export const mealWindowKeys = {
  all: ['meal-windows'] as const,
  lists: () => [...mealWindowKeys.all, 'list'] as const,
  list: () => [...mealWindowKeys.lists()] as const,
} as const;
