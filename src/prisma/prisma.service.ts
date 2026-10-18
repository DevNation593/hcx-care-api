import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { RlsContext, RlsContextService } from './rls-context.service';
import { assertTestDatabaseSafety } from './test-database-safety';
import { prismaRuntimeOptions } from './prisma-runtime-options';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private rlsClient: PrismaClient | null = null;

  constructor(private readonly rlsContext: RlsContextService) {
    super(prismaRuntimeOptions());
  }

  async onModuleInit() {
    await this.$connect();
    this.rlsClient = this.$extends({
      query: {
        $allModels: {
          $allOperations: async ({ model, operation, args, query }) => {
            const context = this.rlsContext.get();
            if (!context?.tenantId || context.skipRlsWrap || !model) {
              return query(args);
            }

            return this.rlsContext.withSkipRlsWrap(async () => {
              return this.$transaction(async (tx) => {
                await this.applyRlsContext(tx, context);

                const modelName = `${model.charAt(0).toLowerCase()}${model.slice(1)}`;
                const modelDelegate = (tx as any)[modelName];
                const action = modelDelegate?.[operation];

                if (typeof action !== 'function') {
                  return query(args);
                }

                return action.call(modelDelegate, args);
              });
            });
          },
        },
      },
    }) as unknown as PrismaClient;

    this.bindRlsDelegates();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  private bindRlsDelegates() {
    if (!this.rlsClient) {
      return;
    }

    const delegateNames = [
      'tenant',
      'tenantSubscription',
      'tenantSettings',
      'subscriptionEvent',
      'usageMetrics',
      'invoice',
      'invoicingConnection',
      'branchEmissionPoint',
      'invoicingRef',
      'invoiceRequest',
      'invoiceRequestEvent',
      'specialtyRecord',
      'formDefinition',
      'encounter',
      'branch',
      'medication',
      'documentTemplate',
      'userPermission',
      'patientFile',
      'professionalBranch',
      'treatment',
      'treatmentVersion',
      'consentTemplate',
      'consentTemplateVersion',
      'consentDocument',
      'consentSignature',
      'consentEvent',
      'treatmentSession',
      'billingProfile',
      'patientBillingProfile',
      'cashRegisterSession',
      'order',
      'orderItem',
      'payment',
      'professionalProfile',
      'user',
      'refreshToken',
      'patient',
      'patientProfessional',
      'appointment',
      'clinicalNote',
      'task',
      'nextSessionPlan',
      'notificationLog',
      'auditLog',
    ];

    for (const delegateName of delegateNames) {
      (this as any)[delegateName] = (this.rlsClient as any)[delegateName];
    }
  }

  withRlsContext<T>(context: RlsContext, callback: () => Promise<T>): Promise<T> {
    const current = this.rlsContext.get();
    if (current) {
      this.rlsContext.set(context);
      return callback();
    }

    return this.rlsContext.run(context, callback);
  }

  async applyRlsContext(tx: any, context?: RlsContext): Promise<void> {
    const effectiveContext = context || this.rlsContext.get();
    if (!effectiveContext) {
      return;
    }

    if (effectiveContext.tenantId) {
      await tx.$executeRaw`
        SELECT set_config('app.current_tenant_id', ${effectiveContext.tenantId}, true)
      `;
    }

    if (effectiveContext.userId) {
      await tx.$executeRaw`
        SELECT set_config('app.current_user_id', ${effectiveContext.userId}, true)
      `;
    }

    if (effectiveContext.role) {
      await tx.$executeRaw`
        SELECT set_config('app.current_user_role', ${effectiveContext.role}, true)
      `;
    }
  }

  // Helper method to clean database (for testing)
  // Models ordered so child tables are deleted before parent tables (FK constraints).
  async cleanDatabase() {
    assertTestDatabaseSafety(process.env.NODE_ENV, process.env.DATABASE_URL);

    const orderedModels = [
      'auditLog',
      'invoiceRequestEvent',
      'invoiceRequest',
      'invoicingRef',
      'branchEmissionPoint',
      'invoicingConnection',
      // Payments restrict deleting their order and cash register; items restrict their session.
      'payment',
      'orderItem',
      'order',
      'cashRegisterSession',
      'patientBillingProfile',
      'billingProfile',
      // Consent evidence restricts deleting its document, so it goes first.
      'consentEvent',
      'consentSignature',
      // Sessions restrict deleting their record, encounter, version and consent document.
      'treatmentSession',
      'consentDocument',
      // Treatment versions restrict deleting their form definition and consent version, so
      // they go before the form definitions and after the sessions and documents using them.
      'treatmentVersion',
      'treatment',
      'consentTemplateVersion',
      'consentTemplate',
      'specialtyRecord',
      // Form definitions restrict deleting while answers exist, so they go after the records.
      'formDefinition',
      // Files restrict deleting their uploader, so they go before users.
      'patientFile',
      'encounter',
      'notificationLog',
      'nextSessionPlan',
      'task',
      'clinicalNote',
      'patientProfessional',
      'appointment',
      // Invoices restrict deleting their issuer, so they go before users.
      'invoice',
      'refreshToken',
      'patient',
      'professionalProfile',
      'user',
      'subscriptionEvent',
      'usageMetrics',
      'specialtyRecord',
      'tenantSubscription',
      'tenantSettings',
      'billingSettings',
      'tenant',
    ] as const;

    for (const modelKey of orderedModels) {
      await (this as any)[modelKey].deleteMany();
    }
  }
}
