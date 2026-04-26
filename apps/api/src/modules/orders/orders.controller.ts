import { Body, Controller, NotImplementedException, Post } from '@nestjs/common';

@Controller('orders')
export class OrdersController {
  @Post()
  create(@Body() _body: unknown) {
    throw new NotImplementedException('orders.create lands in 2C');
  }

  @Post('standalone')
  createStandalone(@Body() _body: unknown) {
    throw new NotImplementedException('orders.standalone lands in 2C');
  }
}
