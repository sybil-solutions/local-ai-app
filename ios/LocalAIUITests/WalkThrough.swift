// Walks the app in the Simulator the way a person would: no model at first, add a machine, pick one of its models,
// ask it something, read the answer, start over, remove the machine.
//
// It needs a computer running Local AI with a model ready, on it or on a machine connected to it:
//   TEST_RUNNER_LOCAL_AI_ADDRESS=127.0.0.1 TEST_RUNNER_LOCAL_AI_KEY=<key> \
//     xcodebuild test -project LocalAI.xcodeproj -scheme LocalAI -destination 'platform=iOS Simulator,name=<a simulator>'
// The model on the phone itself can't run in the Simulator; ios/Tools/check-engine.sh proves that part on a Mac.
import XCTest

final class WalkThrough: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() { continueAfterFailure = false }

    private func shot(_ name: String) {
        let picture = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        picture.name = name
        picture.lifetime = .keepAlways
        add(picture)
    }

    func testAddAMachineAndTalkToItsModel() throws {
        let environment = ProcessInfo.processInfo.environment
        let address = try XCTUnwrap(environment["LOCAL_AI_ADDRESS"], "Set TEST_RUNNER_LOCAL_AI_ADDRESS")
        let key = try XCTUnwrap(environment["LOCAL_AI_KEY"], "Set TEST_RUNNER_LOCAL_AI_KEY")
        // Starts as a new install would: what an earlier run saved is hidden for this launch (a value given on the
        // command line is read before the saved one, and these are not ones the app can read as its own).
        app.launchArguments = ["-machines", "none", "-choice", "none"]
        app.launch()

        // Nothing to talk to yet.
        XCTAssertTrue(app.staticTexts["No model yet"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.textFields["Choose a model first"].isEnabled)
        shot("01 no model yet")
        app.buttons["Open Settings"].tap()

        // Settings: the phone's own model is not offered in the Simulator, and no machine is known.
        XCTAssertTrue(app.staticTexts["Runs on an iPhone, not in the Simulator"].waitForExistence(timeout: 5))
        shot("02 settings, empty")
        app.buttons["Add a machine"].tap()

        // A wrong key is refused, with why.
        let field = app.textFields["100.90.62.80 or my-mac"], secret = app.secureTextFields["Key (not needed on your Tailscale)"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(address)
        secret.tap()
        secret.typeText("not-the-key")
        app.buttons["Add"].tap()
        XCTAssertTrue(app.staticTexts["That key is wrong"].waitForExistence(timeout: 15))
        shot("03 wrong key refused")

        // The right key adds it, and its models are counted.
        secret.tap()
        secret.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12) + key)
        app.buttons["Add"].tap()
        let ready = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'ready'")).firstMatch
        XCTAssertTrue(ready.waitForExistence(timeout: 20), "the machine was added and has a model ready")
        shot("04 machine added")
        app.buttons["Done"].tap()

        // Back on the conversation, a model has been chosen and is named.
        let composer = app.textFields["Message"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15), "a model was chosen, so there is somewhere to type")
        shot("05 model chosen")

        // The model menu lists it under its machine.
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model:'")).firstMatch.tap()
        XCTAssertTrue(app.buttons["Get LFM3-1.7B"].exists || app.buttons["LFM3-1.7B can’t run here"].waitForExistence(timeout: 5))
        shot("06 model menu")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model:'")).firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 6, dy: 8)).tap() // close the menu

        // Ask something, and read the answer as it is written.
        composer.tap()
        composer.typeText("Reply with the single word: pong")
        app.buttons["Send"].tap()
        let answer = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'pong' AND NOT label CONTAINS 'single word'")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 90), "the model answered")
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 30), "writing ended, so Stop became Send again")
        shot("07 answered")

        // A second question in the same conversation is answered from it.
        composer.tap()
        composer.typeText("Now reply with that same word in capital letters.")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'PONG'")).firstMatch.waitForExistence(timeout: 90), "a follow-up was answered from the conversation")
        shot("08 follow-up answered")

        // A new conversation is empty again.
        app.buttons["New conversation"].tap()
        XCTAssertFalse(answer.exists)
        shot("09 new conversation")

        // Remove the machine: there is nothing to talk to again.
        app.buttons["Settings"].tap()
        let row = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'ready'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.swipeLeft()
        app.buttons["Delete"].tap()
        XCTAssertFalse(row.waitForExistence(timeout: 3))
        shot("10 machine removed")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.staticTexts["No model yet"].waitForExistence(timeout: 15))
    }
}
