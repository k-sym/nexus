# Intent: question expiry and complete bridge workflows
Author: Keith. Status: accepted. Source: conversation approving all three recommendations; issues #365 and #249.

## Problem
An unanswered question can hold a project indefinitely. The bridge has durable ingress but lacks full workflow verification and outbound results.

## Proposed outcome
Expire abandoned questions after a configurable 30 minutes, cancelling the whole run safely. Verify bridge delivery, approval, locking, cancellation and restart recovery together. Return reviewable completion results to the originating agent.

## Affected users and systems
Nexus backend, web dashboard, local NATS bridge and external agent clients.

## Constraints
Keep project claims until the run actually stops. Preserve supervision. External replies require explicit UI confirmation and are not agent tools. Keep migrations additive. Autonomous mode and presence are out of scope.

## Open questions
None blocking; implementation choices delegated in the conversation.
