// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-explicit-any, , no-invalid-this, max-classes-per-file */

import { ChildProcess, spawn } from "child_process";
import { expect } from "chai";
import { PYTHON_PATH } from "../../../test/common.node";
import { Deferred, createDeferred } from "../utils/async";
import { ProcessService } from "./proc.node";

interface IProcData {
	proc: ChildProcess;
	exited: Deferred<boolean>;
}

suite("Process - Process Service", function () {
	// eslint-disable-next-line no-invalid-this
	this.timeout(5000);
	const procsToKill: IProcData[] = [];
	teardown(() => {
		procsToKill.forEach((p) => {
			if (!p.exited.resolved) {
				p.proc.kill();
			}
		});
	});

	function spawnProc(): IProcData {
		const proc = spawn(PYTHON_PATH, [
			"-c",
			"while(True): import time;time.sleep(0.5);print(1)",
		]);
		const exited = createDeferred<boolean>();
		proc.on("exit", () => exited.resolve(true));
		procsToKill.push({ proc, exited });

		return procsToKill[procsToKill.length - 1];
	}

	test("Process is killed", async () => {
		const proc = spawnProc();

		ProcessService.kill(proc.proc.pid);

		expect(await proc.exited.promise).to.equal(true, "process did not die");
	});
	test("Process is alive", async () => {
		const proc = spawnProc();

		expect(ProcessService.isAlive(proc.proc.pid)).to.equal(
			true,
			"process is not alive",
		);
	});
});