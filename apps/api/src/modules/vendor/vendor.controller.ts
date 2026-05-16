import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { VendorService, CreateVendorDto, ServiceAreaDto } from './vendor.service';
import { AdminGuard } from '../auth/admin.guard';

// docs/follow-ups/audits/04-rls-security.md Slice 10 (2026-05-16).
// Vendors are tenant config; mutations are admin-only. GETs stay open
// (desk/dispatch reads vendors — hidden from requesters at the
// presentation layer per feedback_hide_vendor_from_requester).
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
  @UseGuards(AdminGuard)
  create(@Body() dto: CreateVendorDto) {
    return this.vendorService.create(dto);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  update(@Param('id') id: string, @Body() dto: Partial<CreateVendorDto> & { active?: boolean }) {
    return this.vendorService.update(id, dto);
  }

  @Get(':id/service-areas')
  listServiceAreas(@Param('id') id: string) {
    return this.vendorService.listServiceAreas(id);
  }

  @Post(':id/service-areas')
  @UseGuards(AdminGuard)
  addServiceArea(@Param('id') id: string, @Body() dto: ServiceAreaDto) {
    return this.vendorService.addServiceArea(id, dto);
  }

  @Delete(':id/service-areas/:serviceAreaId')
  @UseGuards(AdminGuard)
  removeServiceArea(@Param('id') id: string, @Param('serviceAreaId') serviceAreaId: string) {
    return this.vendorService.removeServiceArea(id, serviceAreaId);
  }
}
