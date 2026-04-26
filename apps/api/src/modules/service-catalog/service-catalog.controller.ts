import { Controller, Get, NotImplementedException, Param, Post } from '@nestjs/common';

@Controller('admin/booking-services')
export class ServiceCatalogController {
  @Get('rules')
  list() {
    throw new NotImplementedException('service rules list lands in 2B');
  }

  @Get('rules/:id')
  findOne(@Param('id') _id: string) {
    throw new NotImplementedException('service rules detail lands in 2B');
  }

  @Post('rules/simulate')
  simulate() {
    throw new NotImplementedException('service rules simulation lands in 2B');
  }
}
