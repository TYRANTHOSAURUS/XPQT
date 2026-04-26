import { Controller, Get, NotImplementedException, Param, Post } from '@nestjs/common';

@Controller('booking-bundles')
export class BookingBundlesController {
  @Get(':id')
  findOne(@Param('id') _id: string) {
    throw new NotImplementedException('booking_bundles.findOne lands in 2C');
  }

  @Post(':id/cancel')
  cancel(@Param('id') _id: string) {
    throw new NotImplementedException('booking_bundles.cancel lands in 2D');
  }
}
