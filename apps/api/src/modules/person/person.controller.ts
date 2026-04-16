import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { PersonService } from './person.service';

@Controller('persons')
export class PersonController {
  constructor(private readonly personService: PersonService) {}

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('type') type?: string,
  ) {
    if (search && search.length >= 2) {
      return this.personService.search(search);
    }
    if (type) {
      return this.personService.listByType(type);
    }
    return this.personService.list();
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.personService.getById(id);
  }

  @Post()
  async create(@Body() dto: {
    first_name: string;
    last_name: string;
    email?: string;
    phone?: string;
    type: string;
    division?: string;
    department?: string;
    cost_center?: string;
    manager_person_id?: string;
  }) {
    return this.personService.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.personService.update(id, dto);
  }
}
