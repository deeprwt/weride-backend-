import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SavedPlace as SavedPlaceRow } from '@prisma/client';
import type { ISODateTime, SavedPlace, SavedPlaceKind } from '@uride/types';
import type { SavedPlaceCreateInput } from '@uride/validation';
import { PrismaService } from '../../common/prisma/prisma.module';

/**
 * Enough for Home, Work and the handful of places a rider actually goes back
 * to. The ceiling exists so this list can always be rendered in one screen and
 * sent in one response; nobody needs a hundred favourites.
 */
const MAX_SAVED_PLACES = 20;

/** Home first, then Work, then everything else newest-first — the order the search screen shows. */
const KIND_ORDER: Readonly<Record<SavedPlaceKind, number>> = { home: 0, work: 1, other: 2 };

/**
 * Places a rider hearted.
 *
 * Kept on the server rather than on the phone: the app has no durable local
 * storage of its own, and a rider who changes phones — or signs in on a second
 * one — expects Home to still be Home.
 */
@Injectable()
export class SavedPlacesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<SavedPlace[]> {
    const rows = await this.prisma.savedPlace.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows
      .map(toSavedPlace)
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  }

  /**
   * Save a place. Saving a Home or Work REPLACES the existing one: that is what
   * "set as home" means, and the partial unique index would reject a second
   * one anyway. The delete and insert share a transaction so a failure never
   * leaves the rider with no Home at all.
   */
  async create(userId: string, input: SavedPlaceCreateInput): Promise<SavedPlace> {
    return this.prisma.$transaction(async (tx) => {
      if (input.kind !== 'other') {
        await tx.savedPlace.deleteMany({ where: { userId, kind: input.kind } });
      } else {
        const count = await tx.savedPlace.count({ where: { userId } });
        if (count >= MAX_SAVED_PLACES) {
          throw new BadRequestException({
            code: 'saved_places_limit',
            message: `You can save up to ${MAX_SAVED_PLACES} places.`,
          });
        }
      }
      const row = await tx.savedPlace.create({
        data: {
          userId,
          kind: input.kind,
          name: input.name,
          address: input.address,
          lat: input.location.lat,
          lng: input.location.lng,
        },
      });
      return toSavedPlace(row);
    });
  }

  /** Ownership is part of the WHERE clause: another rider's id is simply not found. */
  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.savedPlace.deleteMany({ where: { id, userId } });
    if (count === 0) {
      throw new NotFoundException({ code: 'saved_place_not_found', message: 'Place not found.' });
    }
  }
}

function toSavedPlace(row: SavedPlaceRow): SavedPlace {
  return {
    id: row.id,
    kind: row.kind as SavedPlaceKind,
    name: row.name,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    createdAt: row.createdAt.toISOString() as ISODateTime,
  };
}
