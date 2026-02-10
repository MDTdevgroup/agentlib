import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

// The OTLP exporter defaults to http://localhost:4318/v1/traces
const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [getNodeAutoInstrumentations()],
    serviceName: 'peebles-agent-service',
});

sdk.start();

console.log('[Instrumentation] OpenTelemetry SDK started with OTLP Exporter');