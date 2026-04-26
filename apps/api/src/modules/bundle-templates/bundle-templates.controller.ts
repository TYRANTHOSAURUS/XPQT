import { Body, Controller, Delete, Get, NotImplementedException, Param, Patch, Post } from '@nestjs/common';

@Controller('admin/bundle-templates')
export class BundleTemplatesController {
  @Get()
  list() {
    throw new NotImplementedException('bundle_templates.list lands in 2E');
  }

  @Get(':id')
  findOne(@Param('id') _id: string) {
    throw new NotImplementedException('bundle_templates.findOne lands in 2E');
  }

  @Post()
  create(@Body() _body: unknown) {
    throw new NotImplementedException('bundle_templates.create lands in 2E');
  }

  @Patch(':id')
  update(@Param('id') _id: string, @Body() _body: unknown) {
    throw new NotImplementedException('bundle_templates.update lands in 2E');
  }

  @Delete(':id')
  remove(@Param('id') _id: string) {
    throw new NotImplementedException('bundle_templates.remove lands in 2E');
  }
}
