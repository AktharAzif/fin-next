-- The grants `email_sender.sql` needs, written with `{{group}}` placeholders so the integration tests
-- can run them against lane-prefixed roles. In the platform they become entries of
-- `packages/db/roles/grants/email.json`, rendered by the runner (ARCHITECTURE §6.3).
GRANT USAGE ON SCHEMA email
  TO {{fin_console}}, {{fin_admin}}, {{fin_api}}, {{fin_payments}}, {{fin_worker}}, {{fin_email_enqueue}};
-- email_private holds the worker's tables: only the worker and email.enqueue()'s owner may use it, so
-- no other login can name (and so lock) a table in it.
GRANT USAGE ON SCHEMA email_private TO {{fin_worker}}, {{fin_email_enqueue}};
GRANT EXECUTE ON FUNCTION email.enqueue(jsonb)
  TO {{fin_console}}, {{fin_admin}}, {{fin_api}}, {{fin_payments}}, {{fin_worker}};
-- email.enqueue()'s owner (NOLOGIN): what the function reads, and INSERT on the outbox, nothing more.
GRANT SELECT ON email.template_grant TO {{fin_email_enqueue}};
GRANT INSERT ON email_private.outbox TO {{fin_email_enqueue}};
-- Only the worker claims, updates and deletes rows; nobody inserts but email.enqueue().
GRANT SELECT, UPDATE, DELETE ON email_private.outbox TO {{fin_worker}};
GRANT SELECT ON email.template_grant TO {{fin_worker}};
GRANT SELECT, INSERT, UPDATE, DELETE ON email_private.recipient_window TO {{fin_worker}};
GRANT SELECT, INSERT, UPDATE, DELETE ON email_private.daily_budget TO {{fin_worker}};
-- INSERT only so the sender can put back the bucket's row after a restore (it holds no secret).
GRANT SELECT, INSERT, UPDATE ON email_private.send_bucket TO {{fin_worker}};
GRANT SELECT, INSERT, UPDATE ON email_private.delivery_check TO {{fin_worker}};
-- UPDATE is what lets the worker take the delivery check's turn (a row lock); INSERT only so the worker
-- can put back the turn's row after a restore.
GRANT SELECT, INSERT, UPDATE ON email_private.delivery_check_turn TO {{fin_worker}};
