-- The grants `email_sender.sql` needs, written with `{{group}}` placeholders so the integration tests
-- can run them against lane-prefixed roles. In the platform they become entries of
-- `packages/db/roles/grants/email.json`, rendered by the runner (ARCHITECTURE §6.3).
GRANT USAGE ON SCHEMA email TO {{fin_console}}, {{fin_admin}}, {{fin_api}}, {{fin_payments}}, {{fin_worker}};
GRANT EXECUTE ON FUNCTION email.enqueue(jsonb)
  TO {{fin_console}}, {{fin_admin}}, {{fin_api}}, {{fin_payments}}, {{fin_worker}};
-- Only the worker claims, updates and deletes rows; nobody inserts but email.enqueue().
GRANT SELECT, UPDATE, DELETE ON email.outbox TO {{fin_worker}};
GRANT SELECT ON email.template_grant TO {{fin_worker}};
GRANT SELECT, INSERT, UPDATE, DELETE ON email.recipient_window TO {{fin_worker}};
GRANT SELECT, INSERT, UPDATE, DELETE ON email.daily_budget TO {{fin_worker}};
-- INSERT only so the sender can put back the bucket's row after a restore (it holds no secret).
GRANT SELECT, INSERT, UPDATE ON email.send_bucket TO {{fin_worker}};
GRANT SELECT, INSERT, UPDATE ON email.delivery_check TO {{fin_worker}};
-- UPDATE is what lets the worker, and no other service, take the delivery check's turn (a row lock);
-- INSERT only so the worker can put back the turn's row after a restore.
GRANT SELECT, INSERT, UPDATE ON email.delivery_check_turn TO {{fin_worker}};
