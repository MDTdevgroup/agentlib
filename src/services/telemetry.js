import { loadOptional } from '../util/optional-dep.js';

const OTLP_INSTALL_CMD = 'npm install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto @opentelemetry/auto-instrumentations-node';

/**
 * Initializes the OpenTelemetry NodeSDK with OTLP trace exporter and auto-instrumentations.
 *
 * @param {object} [options]
 * @param {string} [options.serviceName='peebles-agent-service']
 * @param {string} [options.exporterUrl]
 * @param {any[]} [options.instrumentations]
 * @returns {Promise<any>} The started NodeSDK instance.
 */
export async function initTelemetry({
    serviceName = 'peebles-agent-service',
    exporterUrl,
    instrumentations,
    ...customOptions
} = {}) {
    const { NodeSDK } = await loadOptional(
        '@opentelemetry/sdk-node',
        'OpenTelemetry exporter',
        { installCommand: OTLP_INSTALL_CMD }
    );
    const { OTLPTraceExporter } = await loadOptional(
        '@opentelemetry/exporter-trace-otlp-proto',
        'OpenTelemetry exporter',
        { installCommand: OTLP_INSTALL_CMD }
    );
    const { getNodeAutoInstrumentations } = await loadOptional(
        '@opentelemetry/auto-instrumentations-node',
        'OpenTelemetry exporter',
        { installCommand: OTLP_INSTALL_CMD }
    );

    const traceExporter = new OTLPTraceExporter(exporterUrl ? { url: exporterUrl } : undefined);
    const resolvedInstrumentations = instrumentations || [getNodeAutoInstrumentations()];

    const sdk = new NodeSDK({
        traceExporter,
        instrumentations: resolvedInstrumentations,
        serviceName,
        ...customOptions,
    });

    await sdk.start();
    console.log(`[Instrumentation] OpenTelemetry SDK started with OTLP Exporter (${serviceName})`);
    return sdk;
}