import { describe } from "vitest";
import { FakeRemote } from "./fakes";
import { remoteContract } from "./remote-contract";

describe("RemoteStore contract: FakeRemote", () => {
  remoteContract(async () => new FakeRemote());
});
