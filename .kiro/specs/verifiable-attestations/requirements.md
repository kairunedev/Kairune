# Requirements Document

## Introduction

Kairune is a trust layer for AI agents that spend. It computes a deterministic trust score (0..1000) for each agent from that agent's attestation history and grants or revokes spending permissions based on the resulting tier. The core value proposition is a *verifiable* trust mark.

Today, any client can submit an attestation via `POST /api/agents/:id/attestations` with no authentication and no cryptographic verification. Because the attestation data drives the trust score, this creates a credibility gap: the data feeding the "verifiable" score can be trivially fabricated.

This feature introduces **verifiable (signed) attestations**. It adds the concept of an attestation *issuer* with a registered public key, lets issuers cryptographically sign attestations, verifies those signatures server-side, records each attestation's verification status, and lets the trust score engine weight verified attestations differently from unverified ones. Existing unauthenticated submissions continue to work but are recorded as unverified so current integrations do not break.

## Glossary

- **Kairune_API**: The Express REST service that exposes agent, attestation, permission, issuer, and stats endpoints under `/api`.
- **Attestation**: A behavior record (e.g. `task_completed`, `clean_payment`, `dispute`) recorded against an agent that contributes to that agent's trust score.
- **Issuer**: A registered identity authorized to submit attestations. An Issuer has a unique id, a display name, an API key, and one or more registered public keys.
- **Issuer_Key**: A cryptographic public key belonging to an Issuer, used to verify signatures on submitted attestations. An Issuer_Key has a status of `active` or `revoked`.
- **API_Key**: A secret bearer token assigned to an Issuer at registration, presented on submissions to identify the Issuer.
- **Signature**: A cryptographic signature produced by an Issuer over a canonical representation of an attestation's fields, using the private key that corresponds to a registered Issuer_Key.
- **Canonical_Payload**: The deterministic, byte-for-byte reproducible serialization of the attestation fields that are signed and verified (agent id, kind, amount, note, issuer id, key id, and issued-at timestamp).
- **Verification_Status**: The recorded outcome of server-side signature checking for an attestation, one of `verified` or `unverified`.
- **Verification_Engine**: The Kairune_API component that validates an incoming attestation's Signature against a registered active Issuer_Key and assigns its Verification_Status.
- **Trust_Score_Engine**: The `trustScore` service that computes an agent's score, tier, and breakdown from that agent's attestations.
- **Verified_Weight_Factor**: The multiplier applied to an unverified attestation's base weight when computing the trust score. Verified attestations use a factor of 1.0.
- **Admin**: An operator authenticated via the existing `X-Admin-Key` mechanism in the moderation middleware.
- **Trust_Card**: The public-facing representation of an agent's trust score and supporting attestation data surfaced through the Kairune_API.

## Requirements

### Requirement 1: Issuer Registration

**User Story:** As an Admin, I want to register attestation issuers with an identity and credentials, so that only known parties can submit verifiable attestations.

#### Acceptance Criteria

1. WHEN an Admin submits an issuer registration request with a display name that is 1 to 200 characters in length after trimming leading and trailing whitespace, THE Kairune_API SHALL create an Issuer with a unique id, a generated API_Key of at least 32 characters, a status of `active`, and a creation timestamp recorded as a UTC ISO 8601 datetime.
2. WHEN an Issuer is created, THE Kairune_API SHALL return the generated API_Key exactly once in the registration response.
3. THE Kairune_API SHALL NOT return the API_Key in any response subsequent to the registration response in which it was first exposed.
4. IF a registration request omits the display name, or provides a display name that is empty, contains only whitespace, or exceeds 200 characters after trimming leading and trailing whitespace, THEN THE Kairune_API SHALL reject the request with HTTP status 400, SHALL return error content identifying the specific invalid or missing field, and SHALL NOT create an Issuer.
5. IF a registration request is submitted without a valid Admin credential, THEN THE Kairune_API SHALL reject the request with HTTP status 401, SHALL return error content identifying the missing or invalid credential, and SHALL NOT create an Issuer.
6. WHEN an Admin requests the list of Issuers, THE Kairune_API SHALL return each Issuer's id, display name, status, and creation timestamp without exposing the API_Key or any private key material.

### Requirement 2: Issuer Public Key Management

**User Story:** As an Issuer, I want to register, rotate, and revoke my public keys, so that I can control which keys are trusted to sign my attestations.

#### Acceptance Criteria

1. WHEN an Issuer authenticated via a valid API_Key submits a public key whose encoded length is between 1 and 4096 bytes inclusive, THE Kairune_API SHALL create an Issuer_Key record with a key id that is unique across all Issuer_Keys, status set to `active`, and a creation timestamp recorded at the time of creation.
2. IF a public key registration, modification, or revocation request presents a missing or invalid API_Key, THEN THE Kairune_API SHALL reject the request with HTTP status 401 and SHALL NOT create, modify, or revoke any Issuer_Key.
3. IF a public key submitted for registration is malformed, defined as using an unsupported algorithm, being unparseable, or having an encoded length greater than 4096 bytes, THEN THE Kairune_API SHALL reject the request with HTTP status 400 and SHALL NOT create an Issuer_Key.
4. WHEN an authenticated Issuer registers a new public key, THE Kairune_API SHALL retain as active only the Issuer_Keys of that Issuer that were active prior to the registration, in addition to the newly created key.
5. WHEN an authenticated Issuer revokes an Issuer_Key that belongs to that same Issuer, THE Kairune_API SHALL set the key's status to `revoked` and record a revocation timestamp at the time of revocation.
6. IF an authenticated Issuer requests revocation of a key id that does not exist, THEN THE Kairune_API SHALL reject the request with HTTP status 404 and SHALL preserve the state of all existing Issuer_Keys unchanged.
7. WHEN an authenticated Issuer requests revocation of an Issuer_Key whose status is already `revoked`, THE Kairune_API SHALL return a success response and SHALL leave the key's revoked status and existing revocation timestamp unchanged.
8. WHERE an Issuer_Key has status `revoked`, THE Verification_Engine SHALL treat attestations signed with that Issuer_Key as unverified.
9. IF an authenticated Issuer requests registration or revocation of an Issuer_Key belonging to an Issuer other than the authenticated Issuer, THEN THE Kairune_API SHALL reject the request with HTTP status 403 and SHALL NOT create, modify, or revoke any Issuer_Key.

### Requirement 3: Signed Attestation Submission

**User Story:** As an Issuer, I want to submit attestations signed with my private key, so that the server can confirm the attestation's authenticity and integrity.

#### Acceptance Criteria

1. WHEN an attestation submission includes an Issuer id, an Issuer_Key id, and a Signature, THE Verification_Engine SHALL reconstruct the Canonical_Payload from the submitted attestation fields (agent id, kind, amount, note, Issuer id, Issuer_Key id, and issued-at timestamp) and verify the Signature against the referenced Issuer_Key.
2. WHEN the Signature verifies against the reconstructed Canonical_Payload and the referenced Issuer_Key has status `active`, THE Kairune_API SHALL record the attestation with Verification_Status `verified` and store the associated Issuer id and Issuer_Key id.
3. WHEN the Signature verifies against the reconstructed Canonical_Payload and the referenced Issuer_Key has status `revoked`, THE Kairune_API SHALL record the attestation with Verification_Status `unverified` and store the associated Issuer id and Issuer_Key id.
4. IF a submission includes at least one but not all three of Issuer id, Issuer_Key id, and Signature, THEN THE Kairune_API SHALL reject the submission with HTTP status 400 without recording the attestation and without modifying the agent's trust score, and return an error message indicating which required verification field is missing.
5. IF the Signature does not verify against the referenced Issuer_Key for the reconstructed Canonical_Payload, THEN THE Kairune_API SHALL reject the submission with HTTP status 400 without recording the attestation and without modifying the agent's trust score, and return an error message indicating that signature verification failed.
6. IF a submission references an Issuer id or Issuer_Key id that does not exist, THEN THE Kairune_API SHALL reject the submission with HTTP status 400 without recording the attestation and without modifying the agent's trust score, and return an error message indicating that the referenced Issuer or Issuer_Key was not found.
7. IF a submission that includes an Issuer id, an Issuer_Key id, and a Signature presents an API_Key that is absent or does not match the referenced Issuer, THEN THE Kairune_API SHALL reject the submission with HTTP status 401 without recording the attestation and without modifying the agent's trust score, and return an error message indicating that Issuer authentication failed.
8. WHERE the Canonical_Payload definition is used for signing and for verification, THE Kairune_API SHALL produce identical byte sequences for identical attestation field values so that any attestation correctly signed with the private key corresponding to an `active` Issuer_Key verifies successfully (round-trip property).

### Requirement 4: Backward-Compatible Unverified Submissions

**User Story:** As an operator of an existing integration, I want the current unauthenticated attestation flow to keep working, so that my integration does not break when verification is introduced.

#### Acceptance Criteria

1. WHEN an attestation submission contains none of Issuer id, Issuer_Key id, or Signature, THE Kairune_API SHALL accept the submission and record the attestation with Verification_Status `unverified`.
2. WHEN an attestation submission omits all three of Issuer id, Issuer_Key id, and Signature, THE Kairune_API SHALL validate that the attestation kind is one of the supported kinds and that the referenced agent exists before recording the attestation.
3. WHEN an attestation is recorded with any Verification_Status, THE Kairune_API SHALL trigger a recalculation of the associated agent's trust score.
4. THE Kairune_API SHALL assign every recorded attestation exactly one Verification_Status of either `verified` or `unverified`.
5. IF an attestation submission that omits all three of Issuer id, Issuer_Key id, and Signature specifies an unsupported attestation kind or references an agent that does not exist, THEN THE Kairune_API SHALL reject the submission with HTTP status 400 and a descriptive error message, SHALL NOT record the attestation, and SHALL NOT recalculate the agent's trust score.
6. IF an attestation submission contains some but not all of Issuer id, Issuer_Key id, and Signature, THEN THE Kairune_API SHALL reject the submission with HTTP status 400 and a descriptive error message and SHALL NOT record the attestation.

### Requirement 5: Verification-Weighted Trust Scoring

**User Story:** As a consumer of trust scores, I want verified attestations to count fully while unverified ones are discounted, so that the score reflects trustworthy data.

#### Acceptance Criteria

1. WHEN the Trust_Score_Engine computes a score, THE Trust_Score_Engine SHALL apply a Verified_Weight_Factor of exactly 1.0 to the base weight of each attestation whose Verification_Status equals `verified`.
2. WHEN the Trust_Score_Engine computes a score, THE Trust_Score_Engine SHALL multiply the base weight of each attestation whose Verification_Status equals `unverified` by a configurable Verified_Weight_Factor constrained to the range 0.0 to 1.0 inclusive.
3. WHERE no Verified_Weight_Factor is configured, THE Trust_Score_Engine SHALL apply a default Verified_Weight_Factor of exactly 0.25 to the base weight of each attestation whose Verification_Status equals `unverified`.
4. IF the configured Verified_Weight_Factor is less than 0.0, greater than 1.0, or non-numeric, THEN THE Trust_Score_Engine SHALL reject the configuration, return an error indicating that the Verified_Weight_Factor is out of the permitted 0.0 to 1.0 range, and apply the default Verified_Weight_Factor of exactly 0.25 to unverified attestations.
5. IF an attestation has a Verification_Status other than `verified` or `unverified`, THEN THE Trust_Score_Engine SHALL exclude that attestation from the computed score and record it in the excluded count returned in the score breakdown.
6. THE Trust_Score_Engine SHALL be deterministic, producing byte-identical score output for identical attestation inputs, identical Verified_Weight_Factor configuration, and identical evaluation timestamp.
7. WHEN the Trust_Score_Engine returns a score breakdown, THE Trust_Score_Engine SHALL include the count of `verified` attestations that contributed to the score, the count of `unverified` attestations that contributed to the score, and the count of excluded attestations.
8. WHEN the Trust_Score_Engine computes a score for an input containing zero attestations, THE Trust_Score_Engine SHALL return the baseline score with verified, unverified, and excluded counts all equal to 0.

### Requirement 6: Surfacing Verification Status

**User Story:** As an API consumer, I want to see the verification status of attestations and their issuers, so that I can independently judge the credibility of an agent's trust score.

#### Acceptance Criteria

1. WHEN the Kairune_API returns an attestation record, THE Kairune_API SHALL include that attestation's Verification_Status as exactly one of the values `verified` or `unverified`.
2. WHERE an attestation has Verification_Status `verified`, THE Kairune_API SHALL include the associated Issuer id and a non-empty Issuer display name in the attestation record.
3. WHERE an attestation has Verification_Status `unverified`, THE Kairune_API SHALL omit any Issuer id and Issuer display name from the attestation record.
4. WHEN the Kairune_API returns an agent's Trust_Card, THE Kairune_API SHALL include the count of verified attestations and the count of unverified attestations contributing to that agent's score, each expressed as a non-negative integer, and SHALL return a value of 0 for a count when no attestations of that Verification_Status contribute to the score.
5. WHEN the Kairune_API returns attestation records, THE Kairune_API SHALL exclude the raw Signature, the Issuer API_Key, and any private key material from the response.

### Requirement 7: Submission Rate Limiting and Abuse Protection

**User Story:** As a platform operator, I want signed and unsigned submissions to remain rate limited, so that verification does not open a new abuse vector.

#### Acceptance Criteria

1. WHEN an attestation submission is received, THE Kairune_API SHALL identify the originating client by its API_Key when an API_Key is present and by its source network address otherwise, and SHALL apply per-client rate limiting to that submission.
2. WHEN an attestation submission is received from an identified client, THE Kairune_API SHALL apply per-client rate limiting to that submission regardless of whether the submission is signed or unsigned.
3. WHERE no client-specific override is configured, THE Kairune_API SHALL enforce a default submission rate limit of 60 submissions per rolling 60-second window per identified client.
4. IF an identified client exceeds its configured submission rate limit, THEN THE Kairune_API SHALL reject further submissions from that client with HTTP status 429 and a retry-after value expressed as a whole number of seconds.
5. WHILE signature verification is performed on a submission, THE Verification_Engine SHALL complete verification of a single attestation within 200 milliseconds at the 95th percentile measured over a rolling window of the 100 most recent verified submissions.
6. IF verification of a single attestation exceeds the 200 millisecond bound, THEN THE Verification_Engine SHALL record no attestation for that submission, SHALL perform no trust-score recalculation for that submission, and SHALL return an error response indicating that verification did not complete within the allowed time.

## Requirements to Confirm

The following policy decisions are proposed above with defaults; please confirm or adjust during review:

- Default Verified_Weight_Factor for unverified attestations is **0.25** (Requirement 5.3).
- Supported signature algorithm(s) — the design assumes a single modern asymmetric scheme (e.g. Ed25519). Confirm whether more than one algorithm must be supported (Requirement 2.1).
- Whether issuer self-service key management is authenticated by API_Key alone, or whether Admin approval is also required (Requirements 1 and 2).
- Whether a replay-protection window (issued-at timestamp freshness) should be enforced on signed submissions, and if so, the acceptable clock-skew tolerance.
