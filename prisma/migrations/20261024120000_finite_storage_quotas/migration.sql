-- storageGB 0 no longer means "unlimited": every plan has a finite quota that grows with its price
-- (getPlanLimits in src/subscription/subscription-pricing.ts).
ALTER TABLE "TenantSubscription" ALTER COLUMN "storageGB" SET DEFAULT 1;

-- Existing subscriptions move up to their plan's new quota. Rows on 0 were unlimited and now get
-- the quota instead of none; no quota goes down.
UPDATE "TenantSubscription" s
SET "storageGB" = q."quota"
FROM (
  VALUES
    ('TRIAL'::"PlanType", 1),
    ('PERSONAL_BASIC'::"PlanType", 2),
    ('PERSONAL_PRO'::"PlanType", 5),
    ('CLINIC_BASIC'::"PlanType", 10),
    ('CLINIC_PRO'::"PlanType", 25),
    ('CLINIC_ENTERPRISE'::"PlanType", 100)
) AS q("planType", "quota")
WHERE s."planType" = q."planType"
  AND s."storageGB" < q."quota";
