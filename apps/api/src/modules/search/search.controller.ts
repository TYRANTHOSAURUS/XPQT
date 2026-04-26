import {
  Controller,
  Get,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SearchKind, SearchService } from './search.service';

const ALLOWED_KINDS: SearchKind[] = [
  'ticket',
  'person',
  'space',
  'room',
  'location',
  'asset',
  'vendor',
  'team',
  'request_type',
];

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  async search(
    @Req() request: Request,
    @Query('q') q?: string,
    @Query('types') types?: string,
    @Query('limit') limit?: string,
  ) {
    const user = (request as Request & { user?: { id?: string } }).user;
    if (!user?.id) throw new UnauthorizedException();

    const parsedTypes = types
      ? (types
          .split(',')
          .map((s) => s.trim())
          .filter((s): s is SearchKind => (ALLOWED_KINDS as string[]).includes(s)))
      : undefined;

    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;

    return this.searchService.search(
      user.id,
      q ?? '',
      parsedTypes,
      Number.isFinite(parsedLimit) ? (parsedLimit as number) : 4,
    );
  }
}
