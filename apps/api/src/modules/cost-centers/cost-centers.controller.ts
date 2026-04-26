import { Body, Controller, Delete, Get, NotImplementedException, Param, Patch, Post } from '@nestjs/common';

@Controller('admin/cost-centers')
export class CostCentersController {
  @Get()
  list() {
    throw new NotImplementedException('cost_centers.list lands in 2E');
  }

  @Get(':id')
  findOne(@Param('id') _id: string) {
    throw new NotImplementedException('cost_centers.findOne lands in 2E');
  }

  @Post()
  create(@Body() _body: unknown) {
    throw new NotImplementedException('cost_centers.create lands in 2E');
  }

  @Patch(':id')
  update(@Param('id') _id: string, @Body() _body: unknown) {
    throw new NotImplementedException('cost_centers.update lands in 2E');
  }

  @Delete(':id')
  remove(@Param('id') _id: string) {
    throw new NotImplementedException('cost_centers.remove lands in 2E');
  }
}
