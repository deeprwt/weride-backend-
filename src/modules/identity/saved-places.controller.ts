import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { SavedPlace } from '@uride/types';
import { savedPlaceCreateSchema, type SavedPlaceCreateInput } from '@uride/validation';
import { CurrentUser, type RequestPrincipal } from '../../common/auth/current-user.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { SavedPlacesService } from './saved-places.service';

/** The signed-in user's saved places. Every route is scoped to the caller. */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me/places')
export class SavedPlacesController {
  constructor(private readonly places: SavedPlacesService) {}

  @Get()
  async list(@CurrentUser() principal: RequestPrincipal): Promise<SavedPlace[]> {
    return this.places.list(principal.userId);
  }

  @Post()
  async create(
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(savedPlaceCreateSchema)) body: SavedPlaceCreateInput,
  ): Promise<SavedPlace> {
    return this.places.create(principal.userId, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() principal: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.places.remove(principal.userId, id);
  }
}
