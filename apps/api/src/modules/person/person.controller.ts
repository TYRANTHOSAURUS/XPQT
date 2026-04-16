import { Controller, Get, Param, Query } from '@nestjs/common';
import { PersonService } from './person.service';

@Controller('persons')
export class PersonController {
  constructor(private readonly personService: PersonService) {}

  @Get()
  async list(@Query('search') search?: string) {
    if (search && search.length >= 2) {
      return this.personService.search(search);
    }
    return this.personService.list();
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.personService.getById(id);
  }
}
