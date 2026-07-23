# @asksql/mongodb

## 0.1.0

### Minor Changes

- Initial release: MongoDB connector implementing the `MongoConnector` contract. Sampling-based schema inference across collections (dotted field paths, BSON type inference, presence stats, opt-in example values) and guarded read-only aggregation-pipeline execution with truncation detection, cancellation, and numeric fidelity (Long / Decimal128 travel as strings).
