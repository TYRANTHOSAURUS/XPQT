import { Controller, Get } from '@nestjs/common';
import { MealWindowsService, type MealWindowRow } from './meal-windows.service';

/**
 * Read-only. Tenant-scoped. No permission gate — the data is non-sensitive
 * (lunch/dinner clock windows) and the create-booking flow needs it for
 * every authenticated user.
 */
@Controller('tenants/current/meal-windows')
export class MealWindowsController {
  constructor(private readonly service: MealWindowsService) {}

  @Get()
  list(): Promise<MealWindowRow[]> {
    return this.service.list();
  }
}
