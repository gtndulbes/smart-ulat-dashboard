/**
 * ============================================================
 * mqttTopics.js — Definisi & helper topik MQTT
 * ============================================================
 */

'use strict';

const BASE = 'smartulat';

const TOPICS = {
  TELEMETRY:       `${BASE}/telemetry`,
  ACTUATOR:        `${BASE}/actuator`,
  POWER:           `${BASE}/power`,
  SELF_MONITORING: `${BASE}/selfmonitoring`,
  STATUS:          `${BASE}/status`,
  ALERT:           `${BASE}/alert`,
  RESPONSE:        `${BASE}/response`,
  FUZZY_PID:       `${BASE}/fuzzypid`,

  CONTROL:         `${BASE}/control`,
  CONFIG:          `${BASE}/config`,

  WILDCARD:        `${BASE}/#`
};

const TOPIC_CATEGORY = {
  [TOPICS.TELEMETRY]:       'telemetry',
  [TOPICS.ACTUATOR]:        'actuator',
  [TOPICS.POWER]:           'power',
  [TOPICS.SELF_MONITORING]: 'selfmonitoring',
  [TOPICS.STATUS]:          'status',
  [TOPICS.ALERT]:           'alert',
  [TOPICS.RESPONSE]:        'response',
  [TOPICS.FUZZY_PID]:       'fuzzypid',
  [TOPICS.CONTROL]:         'control',
  [TOPICS.CONFIG]:          'config'
};

function isValidTopic(topic) {
  return Object.values(TOPICS).includes(topic);
}

function getCategory(topic) {
  return TOPIC_CATEGORY[topic] || 'unknown';
}

function getSubscribeList() {
  return [
    TOPICS.TELEMETRY,
    TOPICS.ACTUATOR,
    TOPICS.POWER,
    TOPICS.SELF_MONITORING,
    TOPICS.STATUS,
    TOPICS.ALERT,
    TOPICS.RESPONSE,
    TOPICS.FUZZY_PID
  ];
}

function getPublishList() {
  return [TOPICS.CONTROL, TOPICS.CONFIG];
}

module.exports = {
  BASE, TOPICS, TOPIC_CATEGORY,
  isValidTopic, getCategory,
  getSubscribeList, getPublishList
};