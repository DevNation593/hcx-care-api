import { MODULE_METADATA } from '@nestjs/common/constants';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
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
    expect(TickAwareThrottlerGuard.prototype).toBeInstanceOf(ThrottlerGuard);
  });

  it('registers the filter that answers every error in Spanish', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) ?? [];

    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: APP_FILTER, useClass: AllExceptionsFilter }),
      ]),
    );
  });
});
