# Defender for Cloud

Posture and threat views for Microsoft Defender for Cloud. Posture comes from Azure Resource Graph, across every
subscription you can read; alerts, control-plane activity and exposure come from Defender XDR advanced hunting.

## What you get

- Workbook `posture`:
  - KPIs: overall secure score, the share of machines on Defender for Servers Plan 2, unhealthy high-severity resources
    and active alerts;
  - secure score per subscription and unhealthy resources by severity;
  - Defender for Servers Plan 2 coverage per subscription;
  - the security controls with the most score to gain, and regulatory compliance per standard;
  - unhealthy resources and active alerts;
  - Defender for Cloud alerts over time and sensitive control-plane operations, from Defender XDR;
  - machines not on Plan 2, recommendation governance, attack paths, and the longest-unhealthy resources.

Resource Graph queries:

| Query | What it shows |
| --- | --- |
| `secure-score` | Secure score per subscription, lowest first. |
| `secure-score-controls` | Security controls ranked by the score you would gain by fixing them. |
| `top-recommendations` | Recommendations by unhealthy resource count, with the healthy share. |
| `unhealthy-resources` | Each unhealthy resource per recommendation, at the chosen severities, with a portal link. |
| `vulnerability-findings` | Vulnerability findings (servers, containers, SQL) by how many resources have them. |
| `active-alerts` | Active Defender for Cloud alerts at the chosen severities. |
| `regulatory-compliance` | Passed and failed controls per compliance standard. |
| `defender-plans` | Every Defender plan and its tier per subscription. |
| `servers-plan2-coverage` | Per subscription: its Defender for Servers plan, and how many Azure VMs and Arc machines are effectively on Plan 2. |
| `servers-not-on-plan2` | Each Azure VM and Arc machine not effectively on Defender for Servers Plan 2. |
| `plan-extensions` | The features of each enabled plan per subscription, such as agentless VM scanning or sensitive data discovery. |
| `unhealthy-since` | Unhealthy resources by how many days they have been unhealthy. |
| `exempt-recommendations` | Recommendations that are exempted or turned off by policy. |
| `attack-paths` | Defender CSPM attack paths by type and risk level. |
| `governance-status` | Recommendations by governance status: completed, on time, overdue or unassigned. |

Advanced hunting queries:

| Query | What it shows |
| --- | --- |
| `xdr-alerts` | Defender for Cloud alerts in Defender XDR, with the cloud resources in their evidence. |
| `sensitive-arm-operations` | Role assignment changes, Defender plan and contact changes, diagnostic setting deletes, Key Vault access policy and NSG rule changes. |
| `internet-exposed-vulnerable-vms` | VMs in Azure, AWS and GCP that the exposure graph marks as internet-exposed and vulnerable to remote code execution. |
| `mde-onboarding-azure-vms` | Azure VMs with their Defender for Endpoint onboarding status and sensor health. |

## How Plan 2 coverage is measured

Coverage reads the `VirtualMachines` pricing: `Standard` with sub-plan `P2` is Plan 2. A machine's effective plan is the
pricing set on the machine itself when there is one (for example a VM set to Free inside a Plan 2 subscription), and
otherwise its subscription's. `ResourceOverrides` counts the machines with their own pricing. Virtual machine scale sets
are not counted. Plan 2 also covers machines in other clouds through connectors, which these queries don't count.

`plan-extensions` shows whether Plan 2 features such as agentless VM scanning are on; `mde-onboarding-azure-vms` shows
whether covered machines are actually onboarded to Defender for Endpoint.

## Credits

Queries adapted from other people's work say so in a comment on their first line.

- Microsoft Learn: [Resource Graph samples for Defender for Cloud](https://learn.microsoft.com/azure/defender-for-cloud/resource-graph-samples),
  the AlertInfo schema reference and the [exposure graph query examples](https://learn.microsoft.com/security-exposure-management/query-enterprise-exposure-graph).
- Microsoft, [Azure/Microsoft-Defender-for-Cloud](https://github.com/Azure/Microsoft-Defender-for-Cloud) and the Defender
  for Cloud workbooks in [microsoft/Application-Insights-Workbooks](https://github.com/microsoft/Application-Insights-Workbooks):
  MIT License, Copyright (c) Microsoft Corporation.
- Alex Verboon, [Hunting-Queries-Detection-Rules](https://github.com/alexverboon/Hunting-Queries-Detection-Rules): MIT
  License, Copyright (c) 2023 Alex Verboon.

The MIT-licensed queries are used under these terms:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
> Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## What it needs

- Reader or Security Reader on the subscriptions you query, for Resource Graph.
- Graph permission `ThreatHunting.Read.All` and a Defender XDR role that can run advanced hunting, for the hunting queries.
- `CloudAuditEvents` needs Defender for Cloud connected to Defender XDR; `ExposureGraphNodes` needs Microsoft Security
  Exposure Management.
