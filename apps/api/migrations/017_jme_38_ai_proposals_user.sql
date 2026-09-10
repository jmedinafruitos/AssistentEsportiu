-- JME-38: strategy_change_proposals.proposed_by is NOT NULL, but an
-- AI-generated proposal has no human actor. Seed a dedicated system account
-- to attribute those rows to. It can never log in — no password_hash is
-- ever set, and /v1/session already rejects any account without one.
INSERT INTO users (name, email, role, sport_role, global_access, active)
SELECT 'Assistent IA', 'ai-proposals@hcsentmenat.local', 'coordinator', 'Sistema', false, true
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'ai-proposals@hcsentmenat.local');
