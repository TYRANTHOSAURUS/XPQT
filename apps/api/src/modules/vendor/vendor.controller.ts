import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { VendorService, CreateVendorDto, ServiceAreaDto } from './vendor.service';

@Controller('vendors')
export class VendorController {
  constructor(private readonly vendorService: VendorService) {}

  @Get()
  list() {
    return this.vendorService.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.vendorService.get(id);
  }

  @Post()
  create(@Body() dto: CreateVendorDto) {
    return this.vendorService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Partial<CreateVendorDto> & { active?: boolean }) {
    return this.vendorService.update(id, dto);
  }

  @Get(':id/service-areas')
  listServiceAreas(@Param('id') id: string) {
    return this.vendorService.listServiceAreas(id);
  }

  @Post(':id/service-areas')
  addServiceArea(@Param('id') id: string, @Body() dto: ServiceAreaDto) {
    return this.vendorService.addServiceArea(id, dto);
  }

  @Delete(':id/service-areas/:serviceAreaId')
  removeServiceArea(@Param('id') id: string, @Param('serviceAreaId') serviceAreaId: string) {
    return this.vendorService.removeServiceArea(id, serviceAreaId);
  }
}
