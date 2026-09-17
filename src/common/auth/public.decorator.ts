import { SetMetadata } from '@nestjs/common';

/** Mark a route as not requiring a valid session. */
export const IS_PUBLIC_KEY = 'auth:isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
