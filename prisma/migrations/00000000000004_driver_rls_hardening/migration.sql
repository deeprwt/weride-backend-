-- Phase 2 hardening: stop a driver writing their own KYC decision.
--
-- Migration 00000000000003 gave drivers self-service RLS policies so they can
-- manage their own application:
--
--   driver_profiles_self_update   FOR UPDATE USING (user_id = auth_uid())
--   vehicles_self_all             FOR ALL    USING/WITH CHECK (driver_id = auth_uid())
--   driver_documents_self_all     FOR ALL    USING/WITH CHECK (driver_id = auth_uid())
--
-- Those scope rows correctly but say nothing about COLUMNS. Postgres RLS
-- cannot: a policy's WITH CHECK sees only the new row, never which columns
-- moved. So a driver reaching the database directly through PostgREST could
-- `UPDATE driver_profiles SET kyc_status = 'approved'` on their own row, or
-- insert a vehicle that is already `approved`, and hand themselves the right
-- to carry passengers with no human review. That is the single worst
-- self-service escalation the schema allows.
--
-- The fix is a trigger, because it is the only mechanism here that can see
-- OLD vs NEW. It keys off auth_uid(), which returns the end user's id when the
-- request carries a JWT and NULL when it does not — so the Nest service (which
-- connects as the table owner with no request.jwt.* setting) is unaffected,
-- while every end-user-authenticated path is policed. Column-level GRANTs
-- would be the other textbook answer; they are deferred because no dedicated
-- least-privilege role exists yet, and a trigger keyed on auth_uid() does not
-- depend on how that role is eventually named.

-- =============================================================================
-- driver_profiles — the decision columns
-- =============================================================================
CREATE OR REPLACE FUNCTION guard_driver_profile_decision_columns()
  RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  -- No JWT on the session: this is the API service acting as table owner.
  IF auth_uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.kyc_status IS DISTINCT FROM 'not_started'
       OR NEW.approved_at   IS NOT NULL
       OR NEW.approved_by   IS NOT NULL
       OR NEW.submitted_at  IS NOT NULL
       OR NEW.suspended_at  IS NOT NULL THEN
      RAISE EXCEPTION
        'driver_profiles: a driver may not set their own review state'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.kyc_status       IS DISTINCT FROM OLD.kyc_status
     OR NEW.approved_at       IS DISTINCT FROM OLD.approved_at
     OR NEW.approved_by       IS DISTINCT FROM OLD.approved_by
     OR NEW.submitted_at      IS DISTINCT FROM OLD.submitted_at
     OR NEW.rejection_reason  IS DISTINCT FROM OLD.rejection_reason
     OR NEW.suspended_at      IS DISTINCT FROM OLD.suspended_at
     OR NEW.suspension_reason IS DISTINCT FROM OLD.suspension_reason
     -- Rating and ride counters are earned, not declared.
     OR NEW.rating_sum   IS DISTINCT FROM OLD.rating_sum
     OR NEW.rating_count IS DISTINCT FROM OLD.rating_count
     OR NEW.total_rides  IS DISTINCT FROM OLD.total_rides THEN
    RAISE EXCEPTION
      'driver_profiles: a driver may not change their own review state or ratings'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER driver_profiles_guard_decision_columns
  BEFORE INSERT OR UPDATE ON "driver_profiles"
  FOR EACH ROW EXECUTE FUNCTION guard_driver_profile_decision_columns();

-- =============================================================================
-- vehicles — status is a reviewer's verdict
-- =============================================================================
CREATE OR REPLACE FUNCTION guard_vehicle_decision_columns()
  RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  IF auth_uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' OR NEW.rejection_reason IS NOT NULL THEN
      RAISE EXCEPTION 'vehicles: a driver may not approve their own vehicle'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason THEN
    RAISE EXCEPTION 'vehicles: a driver may not approve their own vehicle'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER vehicles_guard_decision_columns
  BEFORE INSERT OR UPDATE ON "vehicles"
  FOR EACH ROW EXECUTE FUNCTION guard_vehicle_decision_columns();

-- =============================================================================
-- driver_documents — a driver uploads; only a reviewer judges
-- =============================================================================
CREATE OR REPLACE FUNCTION guard_document_decision_columns()
  RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  IF auth_uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending'
       OR NEW.reviewed_by IS NOT NULL
       OR NEW.reviewed_at IS NOT NULL
       OR NEW.rejection_reason IS NOT NULL THEN
      RAISE EXCEPTION 'driver_documents: a driver may not review their own document'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason THEN
    RAISE EXCEPTION 'driver_documents: a driver may not review their own document'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER driver_documents_guard_decision_columns
  BEFORE INSERT OR UPDATE ON "driver_documents"
  FOR EACH ROW EXECUTE FUNCTION guard_document_decision_columns();

-- =============================================================================
-- driver_availability — dispatch state, not self-declared
--
-- Going online/offline is a legitimate driver action, so `status` stays
-- writable. `current_ride_id` is not: it is assigned by the matcher, and a
-- driver who could set it arbitrarily could attach themselves to someone
-- else's ride or make themselves permanently invisible to dispatch.
-- =============================================================================
CREATE OR REPLACE FUNCTION guard_availability_dispatch_columns()
  RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  IF auth_uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.current_ride_id IS NOT NULL THEN
      RAISE EXCEPTION 'driver_availability: current_ride_id is assigned by dispatch'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.current_ride_id IS DISTINCT FROM OLD.current_ride_id THEN
    RAISE EXCEPTION 'driver_availability: current_ride_id is assigned by dispatch'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER driver_availability_guard_dispatch_columns
  BEFORE INSERT OR UPDATE ON "driver_availability"
  FOR EACH ROW EXECUTE FUNCTION guard_availability_dispatch_columns();
