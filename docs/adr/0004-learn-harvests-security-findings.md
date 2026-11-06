# The learn pipeline harvests security findings like any other category

The learn pipeline first shipped with a hard-coded gate. The gate dropped `security` wontfix threads in `learn/harvester.js` and dropped `security` clusters again in `port/learn-port.js`. The reason was that a declined security finding is an accepted risk, not a team standard. We removed both gates. Teams often decline security findings for real, repeated reasons, such as false positives on sanitized inputs or internal-only endpoints. With the gate, the reviewer kept raising those findings forever, and learn could never quiet them. Security findings now flow through harvest, cluster, threshold and dedup unchanged.

## Consequences

- A proposed security rule can teach the reviewer to stop flagging a class of vulnerability. The human review of the proposal PR is now the only safeguard, so reviewers must check security rules closely before merging.
- To reject a proposed security rule permanently, add its fingerprint to `review.learn.ignorePath`.
- The `securityDropped` harvest counter and the `clustersAfterSecurityDrop` log field are removed.
