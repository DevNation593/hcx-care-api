import { MODULE_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppModule } from './app.module';
import { TickAwareThrottlerGuard } from './invoicing/invoicing-tick.throttle';

describe('AppModule', () => {
  it('registers a ThrottlerGuard (the tick-aware subclass) as a global guard', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) ?? [];

    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provide: APP_GUARD,
          useClass: TickAwareThrottlerGuard,
        }),
      ]),
    );
  });
});
