import { SetMetadata } from '@nestjs/common';
import { SectionKey } from '../sections/section-catalog';

export const REQUIRE_SECTION_KEY = 'requireSection';

/**
 * Blocks the route when the platform administrator has not enabled this section for the clinic.
 * With a list, the route is reachable when any of the sections is in effect.
 */
export const RequireSection = (key: SectionKey | readonly SectionKey[]) =>
  SetMetadata(REQUIRE_SECTION_KEY, key);
